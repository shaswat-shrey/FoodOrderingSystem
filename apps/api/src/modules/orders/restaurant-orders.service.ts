import type { OrderStatus, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import { decodeCursor, encodeCursor, queryFingerprint } from '../../platform/pagination';
import type { AuditService } from '../audit';
import { localParts, zonedInstant } from '../catalog';
import type { OrderCancellationService } from './cancellation.service';
import type { OrderSettlement } from './settlement';
import type { OrderTimers } from './timers';
import type { OrderTransitions } from './transition.service';

/** FR-RORD-008 tabs. */
export const QUEUE_TABS = {
  NEW: ['PLACED'],
  PREPARING: ['ACCEPTED', 'PREPARING'],
  READY: ['READY_FOR_PICKUP'],
  PICKED_UP: ['PICKED_UP'],
  COMPLETED: ['DELIVERED'],
  CANCELLED: ['CANCELLED', 'REJECTED', 'FAILED'],
} as const satisfies Record<string, OrderStatus[]>;
export type QueueTab = keyof typeof QUEUE_TABS;
/** Tabs that only show today's orders. */
const TODAY_ONLY = new Set<QueueTab>(['PICKED_UP', 'COMPLETED', 'CANCELLED']);

export const REJECT_REASONS = [
  'ITEM_UNAVAILABLE',
  'KITCHEN_BUSY',
  'CLOSING',
  'ADDRESS_ISSUE',
  'OTHER',
] as const;
export const CANCEL_REASONS = [
  'ITEM_UNAVAILABLE',
  'KITCHEN_ISSUE',
  'CUSTOMER_REQUEST',
  'OTHER',
] as const;
const MAX_PREP_EXTENSION = 20; // BR-ORDER-005
const HISTORY_DAYS = 90; // FR-RORD-014

type Row = Prisma.OrderGetPayload<{ include: ReturnType<typeof include> }>;
const include = () =>
  ({
    items: {
      orderBy: { id: 'asc' },
      include: { options: { select: { groupName: true, optionName: true } } },
    },
    address: { select: { area: true } },
    payments: { select: { method: true, status: true } },
  }) satisfies Prisma.OrderInclude;

/** FR-RORD-009 data minimisation: first name and last initial only. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0]} ${parts.at(-1)![0]!.toUpperCase()}.`;
}

/** Restaurant-side order handling (FR-RORD-001…014, API-RORD-001…012). */
export class RestaurantOrdersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly transitions: OrderTransitions,
    private readonly cancellations: OrderCancellationService,
    private readonly timers: OrderTimers,
    private readonly settlement: OrderSettlement,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private startOfToday(timezone = 'Asia/Kolkata') {
    const p = localParts(this.clock.now(), timezone);
    return zonedInstant(p.year, p.month, p.day, 0, timezone);
  }

  private card(o: Row) {
    const paid = o.payments.some(
      (p) =>
        p.method === 'ONLINE' && ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status),
    );
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      placedAt: o.placedAt,
      acceptedAt: o.acceptedAt,
      readyBy: o.readyBy,
      readyAt: o.readyAt,
      prepMinutes: o.prepMinutes,
      customer: shortName(o.contactName),
      area: o.address?.area ?? null,
      payment:
        o.paymentMethod === 'COD'
          ? 'COD'
          : paid || o.paymentMethod === 'WALLET'
            ? 'PAID'
            : 'PENDING',
      itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
      items: o.items.map((i) => ({
        name: i.itemName,
        variant: i.variantName,
        quantity: i.quantity,
        options: i.options.map((x) => x.optionName),
        instructions: i.instructions,
      })),
      cookingInstructions: o.cookingInstructions,
      // Accept countdown for New orders (BR-ORDER-004).
      acceptBy:
        o.status === 'PLACED' && o.placedAt ? new Date(o.placedAt.getTime() + 300_000) : null,
    };
  }

  /** API-RORD-001: a tab, today's (or a given day's) orders, newest first. */
  async queue(
    branchId: string,
    opts: {
      tab?: QueueTab | undefined;
      date?: string | undefined;
      q?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    const statuses = opts.tab ? [...QUEUE_TABS[opts.tab]] : undefined;
    const since = this.startOfToday();
    const day = opts.date
      ? zonedInstant(
          Number(opts.date.slice(0, 4)),
          Number(opts.date.slice(5, 7)),
          Number(opts.date.slice(8, 10)),
          0,
          'Asia/Kolkata',
        )
      : null;
    if (day && this.clock.now().getTime() - day.getTime() > HISTORY_DAYS * 86_400_000)
      throw new AppError('VALIDATION_ERROR', {
        message: `Orders older than ${HISTORY_DAYS} days are in reports.`,
      });
    const context = queryFingerprint(['rorders', branchId, opts.tab, opts.date, opts.q]);
    const after = opts.cursor ? decodeCursor(opts.cursor, context) : null;
    const rows = await this.prisma.order.findMany({
      where: {
        branchId,
        status: statuses ? { in: statuses } : { not: 'PAYMENT_PENDING' },
        ...(opts.q ? { number: { contains: opts.q.toUpperCase() } } : {}),
        ...(day
          ? { placedAt: { gte: day, lt: new Date(day.getTime() + 86_400_000) } }
          : opts.tab && TODAY_ONLY.has(opts.tab)
            ? { placedAt: { gte: since } }
            : {}),
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
      include: include(),
    });
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      items: page.map((o) => this.card(o)),
      nextCursor:
        rows.length > opts.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }

  /** API-RORD-002 */
  async counts(branchId: string) {
    const since = this.startOfToday();
    const out: Record<string, number> = {};
    for (const [tab, statuses] of Object.entries(QUEUE_TABS) as [
      QueueTab,
      readonly OrderStatus[],
    ][]) {
      out[tab] = await this.prisma.order.count({
        where: {
          branchId,
          status: { in: [...statuses] },
          ...(TODAY_ONLY.has(tab) ? { placedAt: { gte: since } } : {}),
        },
      });
    }
    return out;
  }

  /** API-RORD-003 (FR-RORD-009): the restaurant's view of one order. */
  async details(orderId: string) {
    const o = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: include(),
    });
    const [history, share, cancellation, delivery] = await Promise.all([
      this.prisma.orderStatusHistory.findMany({
        where: { orderId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.settlement.estimate(this.prisma, o).catch(() => null),
      this.prisma.orderCancellation.findUnique({
        where: { orderId },
        select: { reasonCode: true, initiatorType: true },
      }),
      this.prisma.delivery.findUnique({
        where: { orderId },
        select: {
          status: true,
          assignedAt: true,
          arrivedRestaurantAt: true,
          pickedUpAt: true,
          partner: {
            select: {
              user: { select: { fullName: true } },
              vehicles: { where: { isActive: true, deletedAt: null }, select: { type: true } },
            },
          },
        },
      }),
    ]);
    return {
      ...this.card(o),
      version: o.version,
      value: share
        ? {
            restaurantShare: share.restaurant,
            commission: share.commission,
            itemsSubtotal: o.itemsSubtotalAmount,
          }
        : null,
      timeline: history.map((h) => ({ status: h.toStatus, at: h.createdAt, by: h.actorType })),
      cancellation,
      // FR-RORD-007: who is coming for the order (first name only) and where they are.
      partner: delivery?.partner
        ? {
            firstName: delivery.partner.user.fullName.split(/\s+/)[0] ?? '',
            vehicleType: delivery.partner.vehicles[0]?.type ?? null,
            deliveryStatus: delivery.status,
            assignedAt: delivery.assignedAt,
            arrivedAt: delivery.arrivedRestaurantAt,
            pickedUpAt: delivery.pickedUpAt,
          }
        : null,
    };
  }

  /** API-RORD-011 (FR-RORD-010): kitchen tickets — no prices, no customer data. */
  async kds(branchId: string) {
    const rows = await this.prisma.order.findMany({
      where: { branchId, status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] } },
      orderBy: { acceptedAt: 'asc' },
      include: include(),
    });
    const now = this.clock.now().getTime();
    return rows.map((o) => {
      const prepMs = (o.prepMinutes ?? 20) * 60_000;
      const elapsed = o.acceptedAt ? now - o.acceptedAt.getTime() : 0;
      return {
        id: o.id,
        number: o.number,
        status: o.status,
        acceptedAt: o.acceptedAt,
        readyBy: o.readyBy,
        elapsedSeconds: Math.floor(elapsed / 1000),
        // Elapsed-time colour (FR-RORD-010).
        urgency: elapsed < prepMs * 0.5 ? 'GREEN' : elapsed < prepMs ? 'AMBER' : 'RED',
        items: o.items.map((i) => ({
          name: i.itemName,
          variant: i.variantName,
          quantity: i.quantity,
          options: i.options.map((x) => x.optionName),
          instructions: i.instructions,
        })),
        cookingInstructions: o.cookingInstructions,
      };
    });
  }

  /** API-RORD-012 (CORE): ticket data for an 80 mm print layout. */
  async kot(orderId: string) {
    const t = (
      await this.kds(
        (await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).branchId,
      )
    ).find((x) => x.id === orderId);
    const o = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: include(),
    });
    return t ?? { ...this.card(o), urgency: null };
  }

  /** API-RORD-004 (FR-RORD-002, T06): exactly one concurrent accept wins. */
  async accept(
    actorId: string,
    orderId: string,
    input: { prepMinutes?: number | undefined; expectedVersion?: number | undefined },
  ) {
    const order = await this.prisma.$transaction(async (tx) => {
      const locked = await this.transitions.lock(tx, orderId);
      const branch = await tx.branch.findUniqueOrThrow({
        where: { id: locked.branchId },
        select: { defaultPrepMinutes: true, rushExtraMinutes: true, rushUntil: true },
      });
      const rush =
        branch.rushUntil && branch.rushUntil > this.clock.now() ? branch.rushExtraMinutes : 0;
      const base = branch.defaultPrepMinutes + rush;
      const prep = input.prepMinutes ?? base;
      // ±50 % of the default, always within 5–90 (FR-RORD-002).
      const lo = Math.max(5, Math.floor(base * 0.5));
      const hi = Math.min(90, Math.ceil(base * 1.5));
      if (prep < lo || prep > hi)
        throw new AppError('VALIDATION_ERROR', {
          details: [
            {
              path: 'prepMinutes',
              code: 'OUT_OF_RANGE',
              message: `Between ${lo} and ${hi} minutes for this order.`,
            },
          ],
        });
      const now = this.clock.now();
      return (
        await this.transitions.apply(tx, {
          orderId,
          to: 'ACCEPTED',
          actor: { type: 'RESTAURANT', id: actorId },
          ...(input.expectedVersion !== undefined
            ? { expectedVersion: input.expectedVersion }
            : {}),
          patch: { prepMinutes: prep, readyBy: new Date(now.getTime() + prep * 60_000) },
          metadata: { prepMinutes: prep },
        })
      ).order;
    });
    await this.timers.afterAccepted(order.id);
    return this.details(order.id);
  }

  /** API-RORD-005 (FR-RORD-003, T07): full refund, coupon and stock back; optionally mark items out of stock. */
  async reject(
    actorId: string,
    orderId: string,
    input: {
      reason: (typeof REJECT_REASONS)[number];
      note?: string | undefined;
      itemIds?: string[] | undefined;
      markUnavailable?: boolean | undefined;
    },
  ) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { select: { id: true, foodItemId: true } } },
    });
    if (input.reason === 'ITEM_UNAVAILABLE') {
      // BR-ORDER-014: name the items.
      const valid = new Set(order.items.map((i) => i.id));
      if (!input.itemIds?.length || input.itemIds.some((i) => !valid.has(i)))
        throw new AppError('VALIDATION_ERROR', {
          details: [
            {
              path: 'itemIds',
              code: 'REQUIRED',
              message: 'Choose the unavailable items from this order.',
            },
          ],
        });
    }
    await this.cancellations.cancel({
      orderId,
      to: 'REJECTED',
      actor: { type: 'RESTAURANT', id: actorId },
      reasonCode: `REJECTED_${input.reason}`,
      note: input.note ?? null,
      fault: 'RESTAURANT',
    });
    if (input.reason === 'ITEM_UNAVAILABLE' && input.markUnavailable) {
      const foodIds = order.items
        .filter((i) => input.itemIds!.includes(i.id))
        .map((i) => i.foodItemId);
      await this.prisma.$transaction(async (tx) => {
        for (const foodItemId of new Set(foodIds))
          await tx.branchItemAvailability.upsert({
            where: { branchId_foodItemId: { branchId: order.branchId, foodItemId } },
            create: {
              branchId: order.branchId,
              foodItemId,
              isAvailable: false,
              updatedBy: actorId,
            },
            update: { isAvailable: false, unavailableUntil: null, updatedBy: actorId },
          });
        await tx.branch.update({
          where: { id: order.branchId },
          data: { menuVersion: { increment: 1 } },
        });
      });
    }
    return this.details(orderId);
  }

  /** API-RORD-006 (T09) */
  async preparing(actorId: string, orderId: string) {
    const order = await this.prisma.$transaction(
      async (tx) =>
        (
          await this.transitions.apply(tx, {
            orderId,
            to: 'PREPARING',
            actor: { type: 'RESTAURANT', id: actorId },
          })
        ).order,
    );
    await this.timers.afterPreparing(order);
    return this.details(orderId);
  }

  /** API-RORD-007 (T11, or T09+T11 from ACCEPTED as one action). */
  async ready(actorId: string, orderId: string) {
    const order = await this.prisma.$transaction(async (tx) => {
      const locked = await this.transitions.lock(tx, orderId);
      if (locked.status === 'ACCEPTED')
        await this.transitions.apply(tx, {
          orderId,
          to: 'PREPARING',
          actor: { type: 'RESTAURANT', id: actorId },
        });
      return (
        await this.transitions.apply(tx, {
          orderId,
          to: 'READY_FOR_PICKUP',
          actor: { type: 'RESTAURANT', id: actorId },
        })
      ).order;
    });
    await this.timers.afterReady(order);
    return this.details(orderId);
  }

  /** API-RORD-008 (FR-RORD-005, BR-ORDER-005): once, up to +20 min, with a reason. */
  async extendPrep(actorId: string, orderId: string, input: { minutes: number; reason: string }) {
    if (input.minutes < 1 || input.minutes > MAX_PREP_EXTENSION)
      throw new AppError('VALIDATION_ERROR', {
        details: [
          { path: 'minutes', code: 'OUT_OF_RANGE', message: `1 to ${MAX_PREP_EXTENSION} minutes.` },
        ],
      });
    await this.prisma.$transaction(async (tx) => {
      const o = await this.transitions.lock(tx, orderId);
      if (o.status !== 'ACCEPTED' && o.status !== 'PREPARING')
        throw new AppError('ORDER_STATE_CONFLICT', {
          message: 'Prep time can only change before the order is ready.',
        });
      const already = await tx.auditLog.count({
        where: { action: 'order.prep_extended', targetId: orderId },
      });
      if (already)
        throw new AppError('ORDER_STATE_CONFLICT', {
          message: 'Prep time can be extended only once.',
        });
      const readyBy = new Date((o.readyBy ?? this.clock.now()).getTime() + input.minutes * 60_000);
      await tx.order.update({
        where: { id: orderId },
        data: {
          readyBy,
          prepMinutes: (o.prepMinutes ?? 0) + input.minutes,
          ...(o.etaMinAt
            ? { etaMinAt: new Date(o.etaMinAt.getTime() + input.minutes * 60_000) }
            : {}),
          ...(o.etaMaxAt
            ? { etaMaxAt: new Date(o.etaMaxAt.getTime() + input.minutes * 60_000) }
            : {}),
          version: { increment: 1 },
        },
      });
      await this.audit.record(
        {
          action: 'order.prep_extended',
          targetType: 'order',
          targetId: orderId,
          actorUserId: actorId,
          reason: input.reason,
          after: { minutes: input.minutes },
        },
        tx,
      );
      await writeOutbox(tx, {
        aggregateType: 'order',
        aggregateId: orderId,
        aggregateVersion: o.version + 1,
        eventType: 'order.prep_extended',
        payload: { orderId, minutes: input.minutes, notifyCustomer: input.minutes >= 10 },
      });
    });
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === 'PREPARING') await this.timers.afterPreparing(order);
    return this.details(orderId);
  }

  /** API-RORD-010 (FR-RORD-012, T10b/T12b): OWNER/MANAGER, full refund, restaurant bears it. */
  async cancel(
    actorId: string,
    orderId: string,
    input: { reason: (typeof CANCEL_REASONS)[number]; note?: string | undefined },
  ) {
    await this.cancellations.cancel({
      orderId,
      actor: { type: 'RESTAURANT', id: actorId },
      reasonCode: `RESTAURANT_${input.reason}`,
      note: input.note ?? null,
      fault: 'RESTAURANT',
    });
    return this.details(orderId);
  }
}
