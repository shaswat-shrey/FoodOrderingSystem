import { randomInt } from 'node:crypto';
import type {
  ClientApp,
  LegalDocumentType,
  Prisma,
  PrismaClient,
  TicketPriority,
  TicketRequesterType,
  TicketStatus,
} from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import { decodeCursor, encodeCursor, queryFingerprint } from '../../platform/pagination';
import { localParts, zonedInstant } from '../catalog';
import type { SettingsService } from '../config';

type Tx = Prisma.TransactionClient;

export const TICKET_CATEGORIES = [
  'ORDER_ISSUE',
  'PAYMENT',
  'REFUND',
  'ACCOUNT',
  'DELIVERY',
  'FEEDBACK',
  'OTHER',
] as const;

/** BR-SUP-001: first-response targets. */
const FIRST_RESPONSE_MINUTES: Record<TicketPriority, number> = {
  URGENT: 5,
  HIGH: 60,
  NORMAL: 24 * 60,
  LOW: 72 * 60,
};
const REOPEN_DAYS = 7; // BR-SUP-003
const ACTIVE_ORDER = new Set([
  'PAYMENT_PENDING',
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
]);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const REQUESTER: Record<ClientApp, TicketRequesterType | null> = {
  CUSTOMER: 'CUSTOMER',
  RESTAURANT: 'RESTAURANT',
  DELIVERY: 'PARTNER',
  ADMIN: null,
};

export interface NewTicket {
  category: (typeof TICKET_CATEGORIES)[number];
  subject?: string | undefined;
  description: string;
  orderId?: string | undefined;
  attachmentFileIds?: string[] | undefined;
}

/** Support tickets for customers, restaurants and partners (FR-CSUP-002…005, API-SUP-002…008). */
export class SupportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  private ticketNumber(): string {
    const { year, month, day } = localParts(this.clock.now(), 'Asia/Kolkata');
    let suffix = '';
    for (let i = 0; i < 6; i++) suffix += CROCKFORD[randomInt(32)];
    return `S${String(year).slice(2)}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}-${suffix}`;
  }

  private dueAt(priority: TicketPriority): Date {
    return new Date(this.clock.now().getTime() + FIRST_RESPONSE_MINUTES[priority] * 60_000);
  }

  /** Attachments must be the requester's own uploaded support files. */
  private async attachable(tx: Tx, userId: string, fileIds: string[]): Promise<void> {
    if (fileIds.length === 0) return;
    const owned = await tx.file.count({
      where: {
        id: { in: fileIds },
        ownerUserId: userId,
        purpose: 'SUPPORT_ATTACHMENT',
        status: { not: 'DELETED' },
      },
    });
    if (owned !== new Set(fileIds).size)
      throw new AppError('VALIDATION_ERROR', {
        message: 'One of the attachments is not available.',
      });
  }

  /**
   * Creates a ticket inside the caller's transaction (order issues use this too).
   * BR-SUP-004 caps tickets a customer opens per IST day.
   */
  async createIn(
    tx: Tx,
    actor: { userId: string; app: ClientApp },
    input: NewTicket & { priority?: TicketPriority; systemNote?: string },
  ) {
    const requesterType = REQUESTER[actor.app];
    if (!requesterType) throw new AppError('FORBIDDEN');
    if (requesterType === 'CUSTOMER') {
      const t = localParts(this.clock.now(), 'Asia/Kolkata');
      const since = zonedInstant(t.year, t.month, t.day, 0, 'Asia/Kolkata');
      const today = await tx.supportTicket.count({
        where: { requesterId: actor.userId, createdAt: { gte: since } },
      });
      if (today >= (await this.settings.get('support.ticketsPerDay'))) {
        throw new AppError('RATE_LIMITED', {
          message:
            'You have opened the maximum number of tickets for today. We will reply to your open tickets soon.',
        });
      }
    }
    let priority: TicketPriority = input.priority ?? 'NORMAL';
    if (input.orderId) {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, userId: actor.userId },
        select: { status: true },
      });
      if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
      // BR-SUP-001: anything about an order in progress is urgent.
      if (!input.priority && ACTIVE_ORDER.has(order.status)) priority = 'URGENT';
    }
    await this.attachable(tx, actor.userId, input.attachmentFileIds ?? []);
    const ticket = await tx.supportTicket.create({
      data: {
        number: this.ticketNumber(),
        requesterId: actor.userId,
        requesterType,
        category: input.category,
        subject: (input.subject ?? input.description).slice(0, 200),
        priority,
        orderId: input.orderId ?? null,
        slaDueAt: this.dueAt(priority),
        createdAt: this.clock.now(),
      },
    });
    const message = await tx.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: actor.userId,
        authorType: requesterType === 'PARTNER' ? 'PARTNER' : requesterType,
        body: input.description,
        createdAt: this.clock.now(),
      },
    });
    if (input.attachmentFileIds?.length) {
      await tx.supportTicketAttachment.createMany({
        data: input.attachmentFileIds.map((fileId) => ({ messageId: message.id, fileId })),
      });
    }
    if (input.systemNote) {
      await tx.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorId: actor.userId,
          authorType: 'SYSTEM',
          body: input.systemNote,
          createdAt: new Date(this.clock.now().getTime() + 1),
        },
      });
    }
    await writeOutbox(tx, {
      aggregateType: 'support_ticket',
      aggregateId: ticket.id,
      aggregateVersion: 1,
      eventType: 'ticket.created',
      payload: { ticketId: ticket.id, number: ticket.number, priority, orderId: ticket.orderId },
    });
    return ticket;
  }

  /** API-SUP-002 */
  async create(actor: { userId: string; app: ClientApp }, input: NewTicket) {
    const ticket = await this.prisma.$transaction((tx) => this.createIn(tx, actor, input));
    return this.get(actor.userId, ticket.id);
  }

  /** API-SUP-003 */
  async list(
    userId: string,
    opts: { status?: TicketStatus | undefined; limit: number; cursor?: string | undefined },
  ) {
    const context = queryFingerprint(['tickets', userId, opts.status]);
    const after = opts.cursor ? decodeCursor(opts.cursor, context) : null;
    const rows = await this.prisma.supportTicket.findMany({
      where: {
        requesterId: userId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after[0] as number) } },
                { createdAt: new Date(after[0] as number), id: { lt: after[1] as string } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
    });
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      items: page.map((t) => ({
        id: t.id,
        number: t.number,
        category: t.category,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        orderId: t.orderId,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      nextCursor:
        rows.length > opts.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }

  private async owned(db: Tx | PrismaClient, userId: string, ticketId: string) {
    const ticket = await db.supportTicket.findFirst({
      where: { id: ticketId, requesterId: userId },
    });
    if (!ticket) throw new AppError('NOT_FOUND', { message: "We couldn't find that ticket." });
    return ticket;
  }

  /** API-SUP-004: internal notes are never shown to the requester. */
  async get(userId: string, ticketId: string) {
    const t = await this.owned(this.prisma, userId, ticketId);
    const messages = await this.prisma.supportTicketMessage.findMany({
      where: { ticketId, isInternal: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { attachments: { select: { fileId: true } } },
    });
    const resolvedAt = t.resolvedAt;
    return {
      id: t.id,
      number: t.number,
      category: t.category,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      orderId: t.orderId,
      createdAt: t.createdAt,
      resolvedAt,
      csat: t.csat,
      canReopen: this.reopenable(t.status, resolvedAt),
      messages: messages.map((m) => ({
        id: m.id,
        from:
          m.authorType === 'CUSTOMER' || m.authorId === userId
            ? 'YOU'
            : m.authorType === 'SYSTEM'
              ? 'SYSTEM'
              : 'SUPPORT',
        body: m.body,
        attachments: m.attachments.map((a) => a.fileId),
        at: m.createdAt,
      })),
    };
  }

  private reopenable(status: TicketStatus, resolvedAt: Date | null): boolean {
    return (
      (status === 'RESOLVED' || status === 'CLOSED') &&
      resolvedAt !== null &&
      this.clock.now().getTime() - resolvedAt.getTime() <= REOPEN_DAYS * 86_400_000
    );
  }

  private async locked(tx: Tx, userId: string, ticketId: string) {
    await tx.$queryRaw`SELECT id FROM support_tickets WHERE id = ${ticketId}::uuid FOR UPDATE`;
    return this.owned(tx, userId, ticketId);
  }

  /** API-SUP-005 */
  async reply(
    userId: string,
    ticketId: string,
    input: { body: string; attachmentFileIds?: string[] | undefined },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, userId, ticketId);
      if (t.status === 'RESOLVED' || t.status === 'CLOSED') {
        throw new AppError('TICKET_STATE_CONFLICT', {
          message: 'This ticket is closed. Reopen it to continue the conversation.',
        });
      }
      await this.attachable(tx, userId, input.attachmentFileIds ?? []);
      const message = await tx.supportTicketMessage.create({
        data: {
          ticketId,
          authorId: userId,
          authorType: t.requesterType === 'PARTNER' ? 'PARTNER' : t.requesterType,
          body: input.body,
          createdAt: this.clock.now(),
        },
      });
      if (input.attachmentFileIds?.length)
        await tx.supportTicketAttachment.createMany({
          data: input.attachmentFileIds.map((fileId) => ({ messageId: message.id, fileId })),
        });
      // The customer answered: the ball is back with support.
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { status: 'OPEN', updatedAt: this.clock.now() },
      });
      await writeOutbox(tx, {
        aggregateType: 'support_ticket',
        aggregateId: ticketId,
        aggregateVersion: 1,
        eventType: 'ticket.customer_replied',
        payload: { ticketId, messageId: message.id },
      });
    });
    return this.get(userId, ticketId);
  }

  /** API-SUP-006 */
  async close(userId: string, ticketId: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, userId, ticketId);
      if (t.status === 'CLOSED') return;
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { status: 'CLOSED', resolvedAt: t.resolvedAt ?? this.clock.now() },
      });
    });
    return this.get(userId, ticketId);
  }

  /** API-SUP-007 (BR-SUP-003): within 7 days of resolution. */
  async reopen(userId: string, ticketId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, userId, ticketId);
      if (!this.reopenable(t.status, t.resolvedAt)) {
        throw new AppError('TICKET_STATE_CONFLICT', {
          message: 'This ticket can no longer be reopened. Please open a new one.',
        });
      }
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { status: 'OPEN', resolvedAt: null, slaDueAt: this.dueAt(t.priority) },
      });
      await tx.supportTicketMessage.create({
        data: {
          ticketId,
          authorId: userId,
          authorType: t.requesterType === 'PARTNER' ? 'PARTNER' : t.requesterType,
          body: `Reopened: ${reason}`,
          createdAt: this.clock.now(),
        },
      });
    });
    return this.get(userId, ticketId);
  }

  /** API-SUP-008 (FR-CSUP-005): once, after resolution. */
  async rate(userId: string, ticketId: string, score: number) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, userId, ticketId);
      if (t.status !== 'RESOLVED' && t.status !== 'CLOSED')
        throw new AppError('TICKET_STATE_CONFLICT', {
          message: 'You can rate support once your ticket is resolved.',
        });
      if (t.csat !== null)
        throw new AppError('TICKET_STATE_CONFLICT', {
          message: 'You have already rated this ticket.',
        });
      await tx.supportTicket.update({ where: { id: ticketId }, data: { csat: score } });
    });
    return this.get(userId, ticketId);
  }

  /* ----------------------------- public content ----------------------------- */

  /** API-SUP-001 */
  async faqs(app: ClientApp, topic?: string) {
    const rows = await this.prisma.faq.findMany({
      where: { app, isActive: true, ...(topic ? { topic } : {}) },
      orderBy: [{ topic: 'asc' }, { position: 'asc' }],
      select: { id: true, topic: true, question: true, answer: true },
    });
    const topics = new Map<string, typeof rows>();
    for (const f of rows) topics.set(f.topic, [...(topics.get(f.topic) ?? []), f]);
    return [...topics].map(([name, items]) => ({
      topic: name,
      items: items.map(({ id, question, answer }) => ({ id, question, answer })),
    }));
  }

  /** API-SUP-009: the current published version, or the grievance officer card (FR-CSUP-006). */
  async legal(type: LegalDocumentType | 'GRIEVANCE_OFFICER') {
    if (type === 'GRIEVANCE_OFFICER')
      return { type, officer: await this.settings.get('legal.grievanceOfficer') };
    const doc = await this.prisma.legalDocument.findFirst({
      where: { type, publishedAt: { lte: this.clock.now() } },
      orderBy: { publishedAt: 'desc' },
      select: { type: true, version: true, content: true, publishedAt: true },
    });
    if (!doc) throw new AppError('NOT_FOUND', { message: 'This document is not available yet.' });
    return doc;
  }
}
