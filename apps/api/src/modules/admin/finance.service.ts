import type {
  CostBearer,
  PayeeType,
  PaymentProvider,
  PaymentStatus,
  PayoutBatchStatus,
  Prisma,
  PrismaClient,
  RefundStatus,
  WebhookProcessingStatus,
} from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { AuditService } from '../audit';
import type { SettingsService } from '../config';
import type { AccountRef, LedgerService } from '../ledger';
import { periodBounds } from '../partners';
import type { PaymentsService, RefundService } from '../payments';
import type { AdminActor, Page } from './admin.http';
import { auditAs, pageArgs, pageMeta } from './admin.http';

type Tx = Prisma.TransactionClient;

const DAY = 86_400_000;
const TERMINAL_ORDER = new Set(['DELIVERED', 'CANCELLED', 'REJECTED', 'FAILED']);
const CAPTURED: PaymentStatus[] = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

const maskAccount = (last4: string | null | undefined) => (last4 ? `XXXXXX${last4}` : null);
const maskIfsc = (ifsc: string | null | undefined) =>
  ifsc ? `${ifsc.slice(0, 4)}${'X'.repeat(Math.max(0, ifsc.length - 4))}` : null;
const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rupees = (paise: number) => (paise / 100).toFixed(2);

const payable = (type: PayeeType, ownerId: string): AccountRef =>
  type === 'PARTNER'
    ? { ownerType: 'PARTNER', ownerId, type: 'PARTNER_PAYABLE' }
    : { ownerType: 'RESTAURANT', ownerId, type: 'RESTAURANT_PAYABLE' };
const cashInHand = (partnerId: string): AccountRef => ({
  ownerType: 'PARTNER',
  ownerId: partnerId,
  type: 'PARTNER_CASH_IN_HAND',
});

interface Line {
  payeeId: string;
  bankAccountId: string;
  amount: number;
  cashDeduction: number;
}

/**
 * Payments, refunds and payouts for the admin console (FR-ADMIN-050/051/121,
 * FR-REFUND-008, FR-SETTLE-002/003, API-ADM-080…087, 091…097). Money is paise.
 */
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /* ---------------- payments (API-ADM-080…083) ---------------- */

  /** API-ADM-080: newest first; `q` is an order number or a provider order/payment id. */
  async paymentList(
    filter: Page & {
      status?: PaymentStatus | undefined;
      provider?: PaymentProvider | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
      q?: string | undefined;
    },
  ) {
    const q = filter.q?.trim();
    const where: Prisma.PaymentWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.provider ? { provider: filter.provider } : {}),
      ...(filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lt: filter.to } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { order: { number: { startsWith: q.toUpperCase() } } },
              { providerOrderId: q },
              { attempts: { some: { providerPaymentId: q } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(filter),
        include: { order: { select: { id: true, number: true, status: true } } },
      }),
      this.prisma.payment.count({ where }),
    ]);
    return {
      items: rows.map((p) => this.paymentRow(p)),
      meta: pageMeta(filter, total),
    };
  }

  private paymentRow(p: {
    id: string;
    method: string;
    provider: string;
    providerOrderId: string | null;
    status: string;
    amount: number;
    capturedAmount: number;
    refundedAmount: number;
    instrumentSummary: string | null;
    failureCode: string | null;
    failureReason: string | null;
    capturedAt: Date | null;
    createdAt: Date;
    order: { id: string; number: string; status: string };
  }) {
    return {
      id: p.id,
      order: p.order,
      method: p.method,
      provider: p.provider,
      providerOrderId: p.providerOrderId,
      status: p.status,
      amount: p.amount,
      capturedAmount: p.capturedAmount,
      refundedAmount: p.refundedAmount,
      instrument: p.instrumentSummary,
      failure: p.failureCode ? { code: p.failureCode, reason: p.failureReason } : null,
      capturedAt: p.capturedAt,
      createdAt: p.createdAt,
    };
  }

  /** API-ADM-081: the payment with its attempts, refunds and webhook events. */
  async payment(id: string) {
    const p = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        order: { select: { id: true, number: true, status: true } },
        attempts: { orderBy: { createdAt: 'asc' } },
        refunds: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!p) throw new AppError('NOT_FOUND', { message: "We couldn't find that payment." });
    const events = p.providerOrderId
      ? await this.prisma.$queryRaw<
          {
            id: string;
            eventId: string;
            eventType: string;
            signatureValid: boolean;
            processingStatus: string;
            error: string | null;
            receivedAt: Date;
            processedAt: Date | null;
          }[]
        >`
          SELECT id, event_id AS "eventId", event_type AS "eventType", signature_valid AS "signatureValid",
            processing_status::text AS "processingStatus", error, received_at AS "receivedAt", processed_at AS "processedAt"
          FROM payment_webhook_events
          WHERE provider = ${p.provider}::"PaymentProvider" AND payload::text LIKE ${`%${p.providerOrderId}%`}
          ORDER BY received_at ASC LIMIT 100`
      : [];
    return {
      ...this.paymentRow(p),
      attempts: p.attempts.map((a) => ({
        id: a.id,
        providerPaymentId: a.providerPaymentId,
        status: a.status,
        amount: a.amount,
        methodDetail: a.methodDetail,
        errorCode: a.errorCode,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
      refunds: p.refunds.map((r) => ({
        id: r.id,
        amount: r.amount,
        status: r.status,
        destination: r.destination,
        providerRefundId: r.providerRefundId,
        createdAt: r.createdAt,
      })),
      webhookEvents: events,
    };
  }

  /** API-ADM-082 ★ (FR-ADMIN-050): re-fetch the provider's view and apply it. */
  async syncPayment(actor: AdminActor, id: string, reason: string) {
    const before = await this.prisma.payment.findUnique({ where: { id } });
    if (!before) throw new AppError('NOT_FOUND', { message: "We couldn't find that payment." });
    const outcome = await this.payments.sync(id);
    const after = await this.payment(id);
    await auditAs(this.audit, actor, {
      action: 'admin.payment_synced',
      targetType: 'payment',
      targetId: id,
      reason,
      before: { status: before.status, capturedAmount: before.capturedAmount },
      after: { status: after.status, capturedAmount: after.capturedAmount, ...outcome },
      sensitivity: 'HIGH',
    });
    return { ...after, sync: outcome };
  }

  /** API-ADM-083: the webhook log (payloads stay server-side). */
  async webhookEvents(
    filter: Page & {
      provider?: PaymentProvider | undefined;
      status?: WebhookProcessingStatus | undefined;
    },
  ) {
    const where: Prisma.PaymentWebhookEventWhereInput = {
      ...(filter.provider ? { provider: filter.provider } : {}),
      ...(filter.status ? { processingStatus: filter.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentWebhookEvent.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(filter),
        select: {
          id: true,
          provider: true,
          eventId: true,
          eventType: true,
          signatureValid: true,
          processingStatus: true,
          error: true,
          receivedAt: true,
          processedAt: true,
        },
      }),
      this.prisma.paymentWebhookEvent.count({ where }),
    ]);
    return { items: rows, meta: pageMeta(filter, total) };
  }

  /* ---------------- refunds (API-ADM-084…087) ---------------- */

  /** API-ADM-084: newest first. */
  async refundList(filter: Page & { status?: RefundStatus | undefined }) {
    const where: Prisma.RefundWhereInput = filter.status ? { status: filter.status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.refund.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(filter),
        include: {
          order: { select: { id: true, number: true } },
          initiator: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.refund.count({ where }),
    ]);
    return { items: rows.map((r) => this.refundView(r)), meta: pageMeta(filter, total) };
  }

  private refundView(r: {
    id: string;
    orderId: string;
    paymentId: string | null;
    amount: number;
    destination: string;
    status: string;
    reasonCode: string;
    note: string | null;
    initiatorType: string;
    costBearer: string;
    attempts: number;
    providerRefundId: string | null;
    createdAt: Date;
    completedAt: Date | null;
    order?: { id: string; number: string };
    initiator?: { id: string; fullName: string } | null;
  }) {
    return {
      id: r.id,
      orderId: r.orderId,
      order: r.order ?? undefined,
      paymentId: r.paymentId,
      amount: r.amount,
      destination: r.destination,
      status: r.status,
      reasonCode: r.reasonCode,
      note: r.note,
      initiatorType: r.initiatorType,
      initiator: r.initiator ?? null,
      costBearer: r.costBearer,
      attempts: r.attempts,
      providerRefundId: r.providerRefundId,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  }

  /** What the customer paid for an order and has not had back, across every method. */
  private async orderRefundable(tx: Tx, orderId: string, walletApplied: number) {
    const [captured, walletDebited, taken] = await Promise.all([
      tx.payment.aggregate({
        where: {
          orderId,
          OR: [
            { method: 'ONLINE', status: { in: CAPTURED } },
            { method: 'COD', status: 'COLLECTED' },
          ],
        },
        _sum: { capturedAmount: true },
      }),
      tx.ledgerTransaction.count({
        where: { type: 'WALLET_DEBIT', referenceType: 'order', referenceId: orderId },
      }),
      tx.refund.aggregate({
        where: { orderId, status: { notIn: ['FAILED', 'CANCELLED'] } },
        _sum: { amount: true },
      }),
    ]);
    return (
      (captured._sum.capturedAmount ?? 0) +
      (walletDebited > 0 ? walletApplied : 0) -
      (taken._sum.amount ?? 0)
    );
  }

  /**
   * API-ADM-085 ★ (FR-ADMIN-051, FR-REFUND-008): a refund on a closed order.
   * Without `refund:approve`, refunds beyond `support.refundLimit` per order
   * wait as REQUESTED (when `requestApproval`) or are refused. Wallet refunds
   * complete at once; source refunds go to the provider.
   */
  async createRefund(
    actor: AdminActor,
    orderId: string,
    input: {
      amount: number;
      items?: { orderItemId: string; quantity: number }[] | undefined;
      destination: 'SOURCE' | 'WALLET';
      reasonCode: string;
      note: string;
      costBearer: CostBearer;
      requestApproval: boolean;
    },
    canApprove: boolean,
  ) {
    const limit = await this.settings.get('support.refundLimit');
    const refund = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
      if (!TERMINAL_ORDER.has(order.status))
        throw new AppError('ORDER_STATE_CONFLICT', {
          message: 'This order is still in progress. Cancel it to refund the customer.',
          details: [{ code: 'CURRENT_STATUS', message: order.status }],
        });

      const items = (input.items ?? []).map((i) => {
        const line = order.items.find((x) => x.id === i.orderItemId);
        if (!line || i.quantity > line.quantity)
          throw new AppError('ISSUE_ITEMS_INVALID', {
            details: [{ path: 'items', code: 'UNKNOWN_OR_TOO_MANY', message: i.orderItemId }],
          });
        return {
          orderItemId: i.orderItemId,
          quantity: i.quantity,
          amount: Math.round((line.lineTotalAmount * i.quantity) / line.quantity),
        };
      });

      const refundable = await this.orderRefundable(tx, orderId, order.walletAppliedAmount);
      const tooMuch = (left: number) =>
        new AppError('REFUND_EXCEEDS_REFUNDABLE', {
          message: `At most ₹${rupees(Math.max(0, left))} can be refunded.`,
          details: [{ path: 'amount', code: 'REFUNDABLE', message: String(Math.max(0, left)) }],
        });
      if (input.amount > refundable) throw tooMuch(refundable);

      let paymentId: string | null = null;
      if (input.destination === 'SOURCE') {
        // FR-REFUND-007: cash was never on a card; it goes back as wallet credit.
        const online = await tx.payment.findMany({
          where: { orderId, method: 'ONLINE', status: { in: CAPTURED } },
          select: { id: true },
        });
        if (online.length === 0)
          throw new AppError('VALIDATION_ERROR', {
            message: 'Nothing was paid online for this order; refund to the wallet instead.',
            details: [{ path: 'destination', code: 'NO_ONLINE_PAYMENT', message: 'WALLET' }],
          });
        let best = { id: online[0]!.id, left: -1 };
        for (const p of online) {
          const left = await this.refunds.refundable(tx, p.id);
          if (left > best.left) best = { id: p.id, left };
        }
        if (input.amount > best.left) throw tooMuch(best.left);
        paymentId = best.id;
      }

      let status: 'APPROVED' | 'REQUESTED' = 'APPROVED';
      if (!canApprove) {
        const used = await tx.refund.aggregate({
          where: {
            orderId,
            initiatorType: 'ADMIN',
            status: { in: ['APPROVED', 'PROCESSING', 'SUCCEEDED'] },
          },
          _sum: { amount: true },
        });
        const left = limit - (used._sum.amount ?? 0);
        if (input.amount > left) {
          if (!input.requestApproval)
            throw new AppError('REFUND_LIMIT_EXCEEDED', {
              details: [
                { path: 'amount', code: 'LIMIT', message: String(limit) },
                { path: 'amount', code: 'REMAINING', message: String(Math.max(0, left)) },
              ],
            });
          status = 'REQUESTED';
        }
      }

      const created = await this.refunds.create(tx, {
        orderId,
        paymentId,
        amount: input.amount,
        destination: input.destination,
        reasonCode: input.reasonCode,
        note: input.note,
        initiatorType: 'ADMIN',
        initiatorId: actor.userId,
        costBearer: input.costBearer,
        status,
        items,
      });
      await tx.order.update({ where: { id: orderId }, data: { refundStatus: 'PENDING' } });
      await auditAs(
        this.audit,
        actor,
        {
          action: status === 'REQUESTED' ? 'admin.refund_requested' : 'admin.refund_created',
          targetType: 'refund',
          targetId: created.id,
          reason: input.note,
          after: {
            orderId,
            amount: input.amount,
            destination: input.destination,
            reasonCode: input.reasonCode,
            costBearer: input.costBearer,
            status,
          },
          sensitivity: 'HIGH',
        },
        tx,
      );
      return created;
    });
    if (refund.status === 'APPROVED') await this.refunds.submit(refund.id);
    return { refund: await this.refundById(refund.id) };
  }

  private async refundById(id: string) {
    const r = await this.prisma.refund.findUnique({ where: { id } });
    if (!r) throw new AppError('NOT_FOUND', { message: "We couldn't find that refund." });
    return this.refundView(r);
  }

  /** API-ADM-086 ★ (FR-REFUND-008): an over-limit refund approved and submitted. */
  async approveRefund(actor: AdminActor, id: string, reason: string) {
    const r = await this.refunds.approve(id);
    await auditAs(this.audit, actor, {
      action: 'admin.refund_approved',
      targetType: 'refund',
      targetId: id,
      reason,
      before: { status: 'REQUESTED' },
      after: { status: 'APPROVED', amount: r.amount, initiatorId: r.initiatorId },
      sensitivity: 'HIGH',
    });
    await this.refunds.submit(id);
    return { refund: await this.refundById(id) };
  }

  /** API-ADM-087 ★ (FR-REFUND-005): a failed refund gets fresh attempts now. */
  async retryRefund(actor: AdminActor, id: string, reason: string) {
    const r = await this.refunds.retry(id);
    await auditAs(this.audit, actor, {
      action: 'admin.refund_retried',
      targetType: 'refund',
      targetId: id,
      reason,
      before: { status: 'FAILED' },
      after: { status: 'APPROVED', amount: r.amount },
      sensitivity: 'HIGH',
    });
    await this.refunds.submit(id);
    return { refund: await this.refundById(id) };
  }

  /* ---------------- payout batches (API-ADM-091…097) ---------------- */

  /** API-ADM-091 */
  async batches(
    filter: Page & { type?: PayeeType | undefined; status?: PayoutBatchStatus | undefined },
  ) {
    const where: Prisma.PayoutBatchWhereInput = {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.payoutBatch.findMany({
        where,
        orderBy: [{ periodStart: 'desc' }, { type: 'asc' }],
        ...pageArgs(filter),
      }),
      this.prisma.payoutBatch.count({ where }),
    ]);
    const sums = await this.prisma.payout.groupBy({
      by: ['batchId', 'status'],
      where: { batchId: { in: rows.map((b) => b.id) } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return {
      items: rows.map((b) => ({
        ...this.batchHead(b),
        totals: this.totals(sums.filter((s) => s.batchId === b.id)),
      })),
      meta: pageMeta(filter, total),
    };
  }

  private batchHead(b: {
    id: string;
    type: PayeeType;
    periodStart: Date;
    periodEnd: Date;
    status: PayoutBatchStatus;
    createdBy: string | null;
    approvedBy: string | null;
    approvedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: b.id,
      type: b.type,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      status: b.status,
      createdBy: b.createdBy,
      approvedBy: b.approvedBy,
      approvedAt: b.approvedAt,
      createdAt: b.createdAt,
    };
  }

  private totals(
    rows: { status: string; _sum: { amount: bigint | null }; _count: { _all: number } }[],
  ) {
    const by = (s: string) => rows.find((r) => r.status === s);
    const n = (s: string) => by(s)?._count._all ?? 0;
    const amt = (s: string) => Number(by(s)?._sum.amount ?? 0n);
    return {
      lines: n('PENDING') + n('PAID') + n('FAILED'),
      amount: amt('PENDING') + amt('PAID') + amt('FAILED'),
      pending: { lines: n('PENDING'), amount: amt('PENDING') },
      paid: { lines: n('PAID'), amount: amt('PAID') },
      failed: { lines: n('FAILED'), amount: amt('FAILED') },
    };
  }

  /** Monday 00:00 IST of the week to pay: the given one, or the last completed week (BR-EARN-004). */
  private period(periodStart: Date | undefined) {
    const now = this.clock.now();
    const week = periodBounds('week', periodStart ?? new Date(now.getTime() - 7 * DAY));
    if (periodStart && week.from.getTime() !== periodStart.getTime())
      throw new AppError('VALIDATION_ERROR', {
        details: [
          {
            path: 'periodStart',
            code: 'NOT_WEEK_START',
            message: `Use ${week.from.toISOString()} (Monday 00:00 IST).`,
          },
        ],
      });
    if (week.from > now)
      throw new AppError('VALIDATION_ERROR', {
        details: [{ path: 'periodStart', code: 'FUTURE', message: 'That week hasn’t started.' }],
      });
    return week;
  }

  /** Amounts already in unpaid lines of earlier batches; balances only move when a line is paid. */
  private async pendingLines(tx: Tx, type: PayeeType) {
    const rows = await tx.payout.groupBy({
      by: [type === 'PARTNER' ? 'partnerId' : 'restaurantId'],
      where: { payeeType: type, status: 'PENDING' },
      _sum: { amount: true, cashDeduction: true },
    });
    return new Map(
      rows.map((r) => [
        (type === 'PARTNER' ? r.partnerId : r.restaurantId)!,
        { amount: Number(r._sum.amount ?? 0n), cash: Number(r._sum.cashDeduction ?? 0n) },
      ]),
    );
  }

  /**
   * BR-EARN-004…006, FR-SETTLE-002/004: one line per payee with a positive
   * balance. Partners: earnings − unremitted cash in hand, at least the
   * minimum, never while a bank change waits for verification. Restaurants:
   * the payable balance. Unpaid lines of earlier batches are netted off.
   */
  private async lines(tx: Tx, type: PayeeType) {
    const pending = await this.pendingLines(tx, type);
    const lines: Line[] = [];
    const skipped: { payeeId: string; reason: string; amount: number }[] = [];
    const balances = await tx.ledgerAccount.findMany({
      where: {
        ownerType: type,
        type:
          type === 'PARTNER'
            ? { in: ['PARTNER_PAYABLE', 'PARTNER_CASH_IN_HAND'] }
            : 'RESTAURANT_PAYABLE',
      },
      select: { ownerId: true, type: true, balance: true },
    });
    const payees = [...new Set(balances.map((b) => b.ownerId!))].sort();
    const minimum = type === 'PARTNER' ? await this.settings.get('partner.minPayoutAmount') : 1;
    for (const payeeId of payees) {
      const bal = (t: string) =>
        Number(balances.find((b) => b.ownerId === payeeId && b.type === t)?.balance ?? 0n);
      const prior = pending.get(payeeId) ?? { amount: 0, cash: 0 };
      let amount: number;
      let cashDeduction = 0;
      if (type === 'PARTNER') {
        // Earnings left once earlier unpaid lines post, less the cash the partner still holds.
        const earnings = bal('PARTNER_PAYABLE') - prior.amount - prior.cash;
        cashDeduction = Math.max(0, bal('PARTNER_CASH_IN_HAND') - prior.cash);
        amount = earnings - cashDeduction;
      } else {
        amount = bal('RESTAURANT_PAYABLE') - prior.amount;
      }
      if (amount <= 0) {
        if (amount < 0 || cashDeduction > 0)
          skipped.push({ payeeId, reason: 'NEGATIVE_CARRY_OVER', amount });
        continue;
      }
      if (amount < minimum) {
        skipped.push({ payeeId, reason: 'BELOW_MINIMUM', amount });
        continue;
      }
      const accounts =
        type === 'PARTNER'
          ? await tx.partnerBankAccount.findMany({
              where: { partnerId: payeeId, status: { in: ['VERIFIED', 'PENDING_VERIFICATION'] } },
              orderBy: { createdAt: 'desc' },
            })
          : await tx.restaurantBankAccount.findMany({
              where: {
                restaurantId: payeeId,
                status: { in: ['VERIFIED', 'PENDING_VERIFICATION'] },
              },
              orderBy: { createdAt: 'desc' },
            });
      if (accounts.some((a) => a.status === 'PENDING_VERIFICATION')) {
        skipped.push({ payeeId, reason: 'BANK_CHANGE_PENDING', amount });
        continue;
      }
      const bank = accounts.find((a) => a.status === 'VERIFIED');
      if (!bank) {
        skipped.push({ payeeId, reason: 'NO_VERIFIED_BANK_ACCOUNT', amount });
        continue;
      }
      lines.push({ payeeId, bankAccountId: bank.id, amount, cashDeduction });
    }
    return { lines, skipped };
  }

  /** API-ADM-092 ★ (FR-SETTLE-002): a DRAFT batch for one payee type and week. */
  async createBatch(
    actor: AdminActor,
    input: { type: PayeeType; periodStart?: Date | undefined; reason: string },
  ) {
    const week = this.period(input.periodStart);
    const out = await this.prisma.$transaction(async (tx) => {
      // One batch generation per payee type at a time, so unpaid lines are counted once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout-batch:${input.type}`}))`;
      const existing = await tx.payoutBatch.findUnique({
        where: { type_periodStart: { type: input.type, periodStart: week.from } },
        select: { id: true },
      });
      if (existing)
        throw new AppError('PAYOUT_STATE_CONFLICT', {
          message: 'A batch for this week already exists.',
          details: [{ path: 'periodStart', code: 'BATCH_EXISTS', message: existing.id }],
        });
      const { lines, skipped } = await this.lines(tx, input.type);
      const batch = await tx.payoutBatch.create({
        data: {
          type: input.type,
          periodStart: week.from,
          periodEnd: week.to,
          createdBy: actor.userId,
        },
      });
      if (lines.length)
        await tx.payout.createMany({
          data: lines.map((l) => ({
            batchId: batch.id,
            payeeType: input.type,
            ...(input.type === 'PARTNER'
              ? { partnerId: l.payeeId, partnerBankAccountId: l.bankAccountId }
              : { restaurantId: l.payeeId, restaurantBankAccountId: l.bankAccountId }),
            amount: BigInt(l.amount),
            cashDeduction: BigInt(l.cashDeduction),
          })),
        });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.payout_batch_created',
          targetType: 'payout_batch',
          targetId: batch.id,
          reason: input.reason,
          after: {
            type: input.type,
            periodStart: week.from.toISOString(),
            lines: lines.length,
            amount: lines.reduce((s, l) => s + l.amount, 0),
            skipped: skipped.length,
          },
          sensitivity: 'HIGH',
        },
        tx,
      );
      return { batchId: batch.id, skipped };
    });
    return { ...(await this.batch(out.batchId)), skipped: out.skipped };
  }

  /** API-ADM-093: the batch with its lines (bank details masked). */
  async batch(id: string) {
    const b = await this.prisma.payoutBatch.findUnique({
      where: { id },
      include: {
        payouts: {
          orderBy: { createdAt: 'asc' },
          include: {
            restaurant: { select: { id: true, brandName: true, legalName: true } },
            partner: { select: { id: true, legalName: true } },
            restaurantBankAccount: { select: { holderName: true, accountLast4: true, ifsc: true } },
            partnerBankAccount: { select: { holderName: true, accountLast4: true, ifsc: true } },
          },
        },
      },
    });
    if (!b) throw new AppError('NOT_FOUND', { message: "We couldn't find that payout batch." });
    const lines = b.payouts.map((p) => {
      const bank = p.partnerBankAccount ?? p.restaurantBankAccount;
      return {
        id: p.id,
        payeeType: p.payeeType,
        payee:
          p.payeeType === 'PARTNER'
            ? { id: p.partner!.id, name: p.partner!.legalName }
            : { id: p.restaurant!.id, name: p.restaurant!.legalName },
        bank: bank
          ? {
              holderName: bank.holderName,
              accountMasked: maskAccount(bank.accountLast4),
              ifsc: maskIfsc(bank.ifsc),
            }
          : null,
        amount: Number(p.amount),
        cashDeduction: Number(p.cashDeduction),
        status: p.status,
        utr: p.utr,
        failureReason: p.failureReason,
        paidAt: p.paidAt,
      };
    });
    const sums = ['PENDING', 'PAID', 'FAILED'].map((s) => {
      const of = lines.filter((l) => l.status === s);
      return {
        status: s,
        _sum: { amount: BigInt(of.reduce((t, l) => t + l.amount, 0)) },
        _count: { _all: of.length },
      };
    });
    return { ...this.batchHead(b), totals: this.totals(sums), lines };
  }

  /** API-ADM-094 ★⧉ (FR-SETTLE-003): DRAFT → APPROVED by someone other than its maker. */
  async approveBatch(actor: AdminActor, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payout_batches WHERE id = ${id}::uuid FOR UPDATE`;
      const b = await tx.payoutBatch.findUnique({ where: { id } });
      if (!b) throw new AppError('NOT_FOUND', { message: "We couldn't find that payout batch." });
      if (b.status !== 'DRAFT')
        throw new AppError('PAYOUT_STATE_CONFLICT', {
          message: `This batch is already ${b.status.toLowerCase().replace(/_/g, ' ')}.`,
        });
      if (b.createdBy === actor.userId)
        throw new AppError('FORBIDDEN', {
          message: 'Someone other than the batch’s creator must approve it.',
        });
      await tx.payoutBatch.update({
        where: { id },
        data: { status: 'APPROVED', approvedBy: actor.userId, approvedAt: this.clock.now() },
      });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.payout_batch_approved',
          targetType: 'payout_batch',
          targetId: id,
          reason,
          before: { status: 'DRAFT' },
          after: { status: 'APPROVED' },
          sensitivity: 'HIGH',
        },
        tx,
      );
    });
    return this.batch(id);
  }

  /** API-ADM-095: the bank transfer file for an approved batch (CSV; bank details masked). */
  async exportBatch(actor: AdminActor, id: string) {
    const b = await this.batch(id);
    if (b.status === 'DRAFT')
      throw new AppError('PAYOUT_STATE_CONFLICT', {
        message: 'Approve the batch before exporting it.',
      });
    const header = [
      'payout_id',
      'payee_type',
      'payee_id',
      'payee_name',
      'account_holder',
      'account_number',
      'ifsc',
      'amount_inr',
      'cash_deduction_inr',
      'status',
      'utr',
    ];
    const rows = b.lines.map((l) =>
      [
        l.id,
        l.payeeType,
        l.payee.id,
        l.payee.name,
        l.bank?.holderName ?? null,
        l.bank?.accountMasked ?? null,
        l.bank?.ifsc ?? null,
        rupees(l.amount),
        rupees(l.cashDeduction),
        l.status,
        l.utr,
      ]
        .map(csvCell)
        .join(','),
    );
    await auditAs(this.audit, actor, {
      action: 'admin.payout_batch_exported',
      targetType: 'payout_batch',
      targetId: id,
      after: { lines: b.lines.length },
      sensitivity: 'NORMAL',
    });
    return {
      batchId: id,
      filename: `payouts-${b.type.toLowerCase()}-${b.periodStart.toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv',
      lines: b.lines.length,
      csv: [header.join(','), ...rows].join('\n') + '\n',
    };
  }

  /** Locks the batch and line for a result; the batch must be approved. */
  private async lockLine(tx: Tx, batchId: string, lineId: string) {
    await tx.$queryRaw`SELECT id FROM payout_batches WHERE id = ${batchId}::uuid FOR UPDATE`;
    const b = await tx.payoutBatch.findUnique({ where: { id: batchId } });
    if (!b) throw new AppError('NOT_FOUND', { message: "We couldn't find that payout batch." });
    const line = await tx.payout.findFirst({ where: { id: lineId, batchId } });
    if (!line) throw new AppError('NOT_FOUND', { message: "We couldn't find that payout line." });
    if (!['APPROVED', 'PROCESSING', 'PARTIALLY_FAILED'].includes(b.status))
      throw new AppError('PAYOUT_STATE_CONFLICT', {
        message:
          b.status === 'DRAFT'
            ? 'Approve the batch before recording payouts.'
            : 'This batch is already paid.',
      });
    return { b, line };
  }

  /** FR-SETTLE-003: PROCESSING while lines are open; then PAID or PARTIALLY_FAILED. */
  private async settleBatch(tx: Tx, batchId: string) {
    const lines = await tx.payout.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { _all: true },
    });
    const n = (s: string) => lines.find((l) => l.status === s)?._count._all ?? 0;
    const status: PayoutBatchStatus =
      n('PENDING') > 0 ? 'PROCESSING' : n('FAILED') > 0 ? 'PARTIALLY_FAILED' : 'PAID';
    await tx.payoutBatch.update({ where: { id: batchId }, data: { status } });
    return status;
  }

  /**
   * API-ADM-096 ★: the bank confirmed the transfer (UTR). Ledger PAYOUT: the
   * payable is cleared by the amount sent plus, for partners, the cash in hand
   * netted off (BR-EARN-006); the money leaves through PAYOUT_CLEARING until
   * bank reconciliation. A failed line may be paid later unless a newer batch
   * already carried the amount.
   */
  async markPaid(
    actor: AdminActor,
    batchId: string,
    lineId: string,
    input: { utr: string; reason: string },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { b, line } = await this.lockLine(tx, batchId, lineId);
      if (line.status === 'PAID')
        throw new AppError('PAYOUT_STATE_CONFLICT', { message: 'This payout is already paid.' });
      if (line.status === 'FAILED') {
        const payee = line.partnerId ?? line.restaurantId!;
        const later = await tx.payout.count({
          where: {
            payeeType: line.payeeType,
            OR: [{ partnerId: payee }, { restaurantId: payee }],
            batch: { periodStart: { gt: b.periodStart } },
          },
        });
        if (later > 0)
          throw new AppError('PAYOUT_STATE_CONFLICT', {
            message: 'A later batch already includes this amount; pay it there.',
          });
      }
      const payee = line.partnerId ?? line.restaurantId!;
      const amount = Number(line.amount);
      const cash = Number(line.cashDeduction);
      await this.ledger.post(tx, {
        type: 'PAYOUT',
        referenceType: 'payout',
        referenceId: line.id,
        description: `Payout ${b.type.toLowerCase()} week of ${b.periodStart.toISOString().slice(0, 10)} (UTR ${input.utr})`,
        createdBy: actor.userId,
        entries: [
          { ...payable(line.payeeType, payee), amount: amount + cash },
          ...(cash > 0 ? [{ ...cashInHand(payee), amount: -cash }] : []),
          { ownerType: 'PLATFORM', ownerId: null, type: 'PAYOUT_CLEARING', amount: -amount },
        ],
      });
      await tx.payout.update({
        where: { id: line.id },
        data: { status: 'PAID', utr: input.utr, paidAt: this.clock.now(), failureReason: null },
      });
      const status = await this.settleBatch(tx, batchId);
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.payout_paid',
          targetType: 'payout',
          targetId: line.id,
          reason: input.reason,
          before: { status: line.status },
          after: {
            status: 'PAID',
            utr: input.utr,
            amount,
            cashDeduction: cash,
            batchStatus: status,
          },
          sensitivity: 'HIGH',
        },
        tx,
      );
    });
    return this.batch(batchId);
  }

  /** API-ADM-097 ★: the transfer failed; balances stay put and roll into the next batch. */
  async markFailed(actor: AdminActor, batchId: string, lineId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const { line } = await this.lockLine(tx, batchId, lineId);
      if (line.status !== 'PENDING')
        throw new AppError('PAYOUT_STATE_CONFLICT', {
          message: `This payout is already ${line.status.toLowerCase()}.`,
        });
      await tx.payout.update({
        where: { id: line.id },
        data: { status: 'FAILED', failureReason: reason.slice(0, 300) },
      });
      const status = await this.settleBatch(tx, batchId);
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.payout_failed',
          targetType: 'payout',
          targetId: line.id,
          reason,
          before: { status: line.status },
          after: { status: 'FAILED', batchStatus: status },
          sensitivity: 'HIGH',
        },
        tx,
      );
    });
    return this.batch(batchId);
  }
}
