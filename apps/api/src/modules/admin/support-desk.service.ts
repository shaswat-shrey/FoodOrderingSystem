import type { Prisma, PrismaClient, ReportStatus, TicketPriority, TicketStatus } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import type { AuditService } from '../audit';
import type { IamService } from '../iam';
import type { ReviewService } from '../reviews';
import { FIRST_RESPONSE_MINUTES } from '../support';
import { auditAs, maskPhone, pageArgs, pageMeta, type AdminActor, type Page } from './admin.http';

type Tx = Prisma.TransactionClient;

const OPEN_STATUSES: TicketStatus[] = ['OPEN', 'PENDING_CUSTOMER', 'PENDING_INTERNAL'];
/** BR-SUP-001 resolution targets once support has answered (LOW is not in the SRS: a week). */
const RESOLUTION_MINUTES: Record<TicketPriority, number> = {
  URGENT: 60,
  HIGH: 24 * 60,
  NORMAL: 72 * 60,
  LOW: 7 * 24 * 60,
};
const ESCALATION: Record<TicketPriority, TicketPriority> = {
  LOW: 'NORMAL',
  NORMAL: 'HIGH',
  HIGH: 'URGENT',
  URGENT: 'URGENT',
};

export type TicketQueue = 'UNASSIGNED' | 'MINE' | 'OVERDUE';

export interface TicketFilter extends Page {
  queue?: TicketQueue | undefined;
  status?: TicketStatus | undefined;
  priority?: TicketPriority | undefined;
  category?: string | undefined;
  assignee?: string | undefined;
  q?: string | undefined;
}

/**
 * The support desk (FR-ADMIN-080, API-ADM-150…155) and review moderation
 * (FR-ADMIN-082, API-ADM-163…165). Customers' side of tickets lives in the
 * support module; every change here is written to the outbox as `ticket.*`
 * so the ops room and the customer's notifications follow.
 */
export class AdminSupportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly iam: IamService,
    private readonly reviews: ReviewService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /* ------------------------------ tickets ------------------------------ */

  /** API-ADM-150: open work first, most urgent and soonest due on top. */
  async tickets(actor: AdminActor, f: TicketFilter) {
    const now = this.clock.now();
    const where: Prisma.SupportTicketWhereInput = {
      status: f.status ?? { in: OPEN_STATUSES },
      ...(f.priority ? { priority: f.priority } : {}),
      ...(f.category ? { category: f.category } : {}),
      ...(f.assignee ? { assigneeId: f.assignee } : {}),
      ...(f.queue === 'UNASSIGNED' ? { assigneeId: null } : {}),
      ...(f.queue === 'MINE' ? { assigneeId: actor.userId } : {}),
      ...(f.queue === 'OVERDUE' ? { slaDueAt: { lt: now } } : {}),
      ...(f.q
        ? {
            OR: [
              { number: { equals: f.q.toUpperCase() } },
              { subject: { contains: f.q, mode: 'insensitive' } },
              { order: { number: { equals: f.q.toUpperCase() } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ priority: 'asc' }, { slaDueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        ...pageArgs(f),
        include: {
          requester: { select: { id: true, fullName: true } },
          assignee: { select: { id: true, fullName: true } },
          order: { select: { id: true, number: true, status: true } },
        },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return {
      items: rows.map((t) => ({
        id: t.id,
        number: t.number,
        category: t.category,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        requester: { ...t.requester, type: t.requesterType },
        assignee: t.assignee,
        order: t.order,
        slaDueAt: t.slaDueAt,
        overdue: t.slaDueAt !== null && t.slaDueAt < now && OPEN_STATUSES.includes(t.status),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      meta: pageMeta(f, total),
    };
  }

  private async locked(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM support_tickets WHERE id = ${id}::uuid FOR UPDATE`;
    const t = await tx.supportTicket.findUnique({ where: { id } });
    if (!t) throw new AppError('NOT_FOUND', { message: "We couldn't find that ticket." });
    return t;
  }

  /** API-ADM-151: the conversation including internal notes, and the linked order. */
  async ticket(id: string) {
    const t = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: {
        requester: { select: { id: true, fullName: true, phone: true, createdAt: true } },
        assignee: { select: { id: true, fullName: true } },
        messages: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: {
            author: { select: { id: true, fullName: true } },
            attachments: { select: { fileId: true } },
          },
        },
        order: {
          select: {
            id: true,
            number: true,
            status: true,
            totalAmount: true,
            paymentMethod: true,
            placedAt: true,
            deliveredAt: true,
            branch: {
              select: { id: true, name: true, restaurant: { select: { brandName: true } } },
            },
          },
        },
      },
    });
    if (!t) throw new AppError('NOT_FOUND', { message: "We couldn't find that ticket." });
    const [orders, openTickets] = await Promise.all([
      this.prisma.order.count({ where: { userId: t.requesterId } }),
      this.prisma.supportTicket.count({
        where: { requesterId: t.requesterId, status: { in: OPEN_STATUSES } },
      }),
    ]);
    return {
      id: t.id,
      number: t.number,
      category: t.category,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      slaDueAt: t.slaDueAt,
      resolvedAt: t.resolvedAt,
      csat: t.csat,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      assignee: t.assignee,
      requester: {
        id: t.requester.id,
        type: t.requesterType,
        fullName: t.requester.fullName,
        phone: maskPhone(t.requester.phone),
        memberSince: t.requester.createdAt,
        orders,
        openTickets,
      },
      order: t.order
        ? {
            id: t.order.id,
            number: t.order.number,
            status: t.order.status,
            totalAmount: t.order.totalAmount,
            paymentMethod: t.order.paymentMethod,
            placedAt: t.order.placedAt,
            deliveredAt: t.order.deliveredAt,
            restaurant: t.order.branch.restaurant.brandName,
            branch: { id: t.order.branch.id, name: t.order.branch.name },
          }
        : null,
      messages: t.messages.map((m) => ({
        id: m.id,
        authorType: m.authorType,
        author: m.author,
        body: m.body,
        internal: m.isInternal,
        attachments: m.attachments.map((a) => a.fileId),
        at: m.createdAt,
      })),
    };
  }

  private event(tx: Tx, ticketId: string, eventType: string, payload: Record<string, unknown>) {
    return writeOutbox(tx, {
      aggregateType: 'support_ticket',
      aggregateId: ticketId,
      aggregateVersion: 1,
      eventType,
      payload: { ticketId, ...payload },
    });
  }

  /**
   * API-ADM-152: a public reply (the customer is notified and the ticket waits
   * on them) or an internal note (never shown to the requester).
   */
  async message(actor: AdminActor, id: string, input: { body: string; internal: boolean }) {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, id);
      if (!input.internal && (t.status === 'RESOLVED' || t.status === 'CLOSED'))
        throw new AppError('TICKET_STATE_CONFLICT', {
          message: 'This ticket is closed. Reopen it before replying to the customer.',
        });
      const m = await tx.supportTicketMessage.create({
        data: {
          ticketId: id,
          authorId: actor.userId,
          authorType: 'ADMIN',
          body: input.body,
          isInternal: input.internal,
          createdAt: now,
        },
      });
      if (!input.internal) {
        const firstReply = !(await tx.supportTicketMessage.findFirst({
          where: { ticketId: id, authorType: 'ADMIN', isInternal: false, id: { not: m.id } },
        }));
        await tx.supportTicket.update({
          where: { id },
          data: {
            status: 'PENDING_CUSTOMER',
            assigneeId: t.assigneeId ?? actor.userId,
            // BR-SUP-001: answered — the clock now runs to the resolution target.
            ...(firstReply
              ? {
                  slaDueAt: new Date(
                    t.createdAt.getTime() + RESOLUTION_MINUTES[t.priority] * 60_000,
                  ),
                }
              : {}),
            updatedAt: now,
          },
        });
        await this.event(tx, id, 'ticket.agent_replied', {
          messageId: m.id,
          priority: t.priority,
        });
      }
      await auditAs(
        this.audit,
        actor,
        {
          action: input.internal ? 'admin.ticket_note_added' : 'admin.ticket_replied',
          targetType: 'support_ticket',
          targetId: id,
          after: { messageId: m.id },
          sensitivity: 'NORMAL',
        },
        tx,
      );
    });
    return this.ticket(id);
  }

  /** Only staff who can work tickets can own them. */
  private async assignable(userId: string) {
    const perms = await this.iam.load(userId);
    if (!perms.platform.includes('support:write'))
      throw new AppError('VALIDATION_ERROR', {
        details: [
          { path: 'assigneeId', code: 'NOT_AGENT', message: 'That person cannot work tickets.' },
        ],
      });
  }

  /** API-ADM-153: assign (or, with null, return to the queue). */
  async assign(actor: AdminActor, id: string, assigneeId: string | null) {
    if (assigneeId) await this.assignable(assigneeId);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, id);
      if (t.assigneeId === assigneeId)
        throw new AppError('RESOURCE_CONFLICT', {
          message: assigneeId ? 'The ticket is already assigned to them.' : 'Nobody owns it.',
        });
      await tx.supportTicket.update({ where: { id }, data: { assigneeId } });
      await this.event(tx, id, 'ticket.assigned', { assigneeId, priority: t.priority });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.ticket_assigned',
          targetType: 'support_ticket',
          targetId: id,
          before: { assigneeId: t.assigneeId },
          after: { assigneeId },
          sensitivity: 'NORMAL',
        },
        tx,
      );
    });
    return this.ticket(id);
  }

  /** API-ADM-154: status, priority and category. */
  async update(
    actor: AdminActor,
    id: string,
    patch: {
      status?: TicketStatus | undefined;
      priority?: TicketPriority | undefined;
      category?: string | undefined;
    },
  ) {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, id);
      const data: Prisma.SupportTicketUpdateInput = { updatedAt: now };
      if (patch.category !== undefined) data.category = patch.category;
      if (patch.priority !== undefined && patch.priority !== t.priority) {
        data.priority = patch.priority;
        data.slaDueAt = await this.dueFor(tx, t, patch.priority);
      }
      if (patch.status !== undefined && patch.status !== t.status) {
        data.status = patch.status;
        const closing = patch.status === 'RESOLVED' || patch.status === 'CLOSED';
        if (closing) data.resolvedAt = t.resolvedAt ?? now;
        else if (t.resolvedAt) data.resolvedAt = null; // reopened by support
      }
      await tx.supportTicket.update({ where: { id }, data });
      await this.event(tx, id, 'ticket.updated', {
        status: patch.status ?? t.status,
        priority: patch.priority ?? t.priority,
      });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.ticket_updated',
          targetType: 'support_ticket',
          targetId: id,
          before: { status: t.status, priority: t.priority, category: t.category },
          after: patch,
          sensitivity: 'NORMAL',
        },
        tx,
      );
    });
    return this.ticket(id);
  }

  /** First response target until support has replied, then the resolution target (BR-SUP-001). */
  private async dueFor(
    tx: Tx,
    t: { id: string; createdAt: Date },
    priority: TicketPriority,
  ): Promise<Date> {
    const answered = await tx.supportTicketMessage.findFirst({
      where: { ticketId: t.id, authorType: 'ADMIN', isInternal: false },
    });
    const minutes = answered ? RESOLUTION_MINUTES[priority] : FIRST_RESPONSE_MINUTES[priority];
    return new Date(t.createdAt.getTime() + minutes * 60_000);
  }

  /**
   * API-ADM-155: one priority step up, back to support's court, with the
   * reason kept as an internal note; optionally handed to a senior agent.
   */
  async escalate(
    actor: AdminActor,
    id: string,
    input: { reason: string; assigneeId?: string | undefined },
  ) {
    if (input.assigneeId) await this.assignable(input.assigneeId);
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, id);
      if (t.status === 'RESOLVED' || t.status === 'CLOSED')
        throw new AppError('TICKET_STATE_CONFLICT', {
          message: 'Reopen the ticket before escalating it.',
        });
      const priority = ESCALATION[t.priority];
      await tx.supportTicket.update({
        where: { id },
        data: {
          priority,
          status: 'PENDING_INTERNAL',
          slaDueAt: await this.dueFor(tx, t, priority),
          ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
          updatedAt: now,
        },
      });
      await tx.supportTicketMessage.create({
        data: {
          ticketId: id,
          authorId: actor.userId,
          authorType: 'ADMIN',
          body: `Escalated (${t.priority} → ${priority}): ${input.reason}`,
          isInternal: true,
          createdAt: now,
        },
      });
      await this.event(tx, id, 'ticket.escalated', {
        priority,
        assigneeId: input.assigneeId ?? t.assigneeId,
      });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.ticket_escalated',
          targetType: 'support_ticket',
          targetId: id,
          reason: input.reason,
          before: { priority: t.priority, status: t.status, assigneeId: t.assigneeId },
          after: {
            priority,
            status: 'PENDING_INTERNAL',
            assigneeId: input.assigneeId ?? t.assigneeId,
          },
          sensitivity: 'NORMAL',
        },
        tx,
      );
    });
    return this.ticket(id);
  }

  /* --------------------------- review moderation --------------------------- */

  /** API-ADM-163: reviews with reports in the given state, most reported first. */
  async reportedReviews(filter: Page & { status?: ReportStatus | undefined }) {
    const status = filter.status ?? 'OPEN';
    const where: Prisma.ReviewWhereInput = {
      deletedAt: null,
      reports: { some: { status } },
    };
    const [rows, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: [{ reports: { _count: 'desc' } }, { createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(filter),
        include: {
          author: { select: { id: true, fullName: true } },
          restaurant: { select: { id: true, brandName: true } },
          branch: { select: { id: true, name: true } },
          reports: {
            where: { status },
            orderBy: { createdAt: 'desc' },
            select: { reason: true, note: true, createdAt: true },
          },
        },
      }),
      this.prisma.review.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        targetType: r.targetType,
        rating: r.rating,
        text: r.text,
        status: r.status,
        createdAt: r.createdAt,
        author: r.author,
        restaurant: r.restaurant,
        branch: r.branch,
        partnerId: r.partnerId,
        reports: {
          count: r.reports.length,
          reasons: r.reports.reduce<Record<string, number>>((acc, x) => {
            acc[x.reason] = (acc[x.reason] ?? 0) + 1;
            return acc;
          }, {}),
          latest: r.reports.slice(0, 5),
        },
      })),
      meta: pageMeta(filter, total),
    };
  }

  /** API-ADM-164/165 ★: hide upholds the reports, unhide dismisses them; ratings recompute. */
  async moderateReview(actor: AdminActor, id: string, hide: boolean, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const result = await this.reviews.moderate(tx, id, hide);
      await auditAs(
        this.audit,
        actor,
        {
          action: hide ? 'admin.review_hidden' : 'admin.review_restored',
          targetType: 'review',
          targetId: id,
          reason,
          before: { status: result.before },
          after: { status: result.status, reportsResolved: result.reportsResolved },
          sensitivity: 'HIGH',
        },
        tx,
      );
      return result;
    });
  }
}
