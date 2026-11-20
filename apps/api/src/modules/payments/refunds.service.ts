import type { CostBearer, Prisma, PrismaClient, Refund } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { JobQueue } from '../../platform/jobs';
import type { Logger } from '../../platform/logger';
import { raiseOpsAlert } from '../../platform/ops-alerts';
import { writeOutbox } from '../../platform/outbox';
import type { AccountRef, LedgerService, WalletService } from '../ledger';
import { ProviderError, type PaymentProvider, type ProviderRefund } from './provider';
import { canTransition } from './status';

type Tx = Prisma.TransactionClient;

export const SUBMIT_REFUND_JOB = 'submit-refund';
/** FR-REFUND-005: 5 attempts over about a day. */
const BACKOFF_MINUTES = [5, 30, 120, 360, 900];

export interface CreateRefundInput {
  orderId: string;
  paymentId: string | null;
  amount: number;
  destination: 'SOURCE' | 'WALLET';
  reasonCode: string;
  note?: string;
  initiatorType: 'CUSTOMER' | 'RESTAURANT' | 'PARTNER' | 'ADMIN' | 'SYSTEM';
  initiatorId?: string | null;
  costBearer: CostBearer;
  /** REQUESTED waits for an approver (FR-REFUND-008); everything else is approved at once. */
  status?: 'APPROVED' | 'REQUESTED';
  /** Item-level refunds (FR-REFUND-003). */
  items?: { orderItemId: string; quantity: number; amount: number }[];
}

/**
 * Refunds (FR-REFUND-001…006, 009) — the skeleton the order flows use from
 * Phase 7. System refunds are auto-approved; submission to the provider runs
 * in the worker with retries; the ledger moves when the provider confirms.
 */
export class RefundService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly wallet: WalletService,
    private readonly jobs: JobQueue,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /**
   * Creates an approved refund inside the caller's transaction. The payment row
   * is locked so concurrent refunds can never exceed what was captured (FR-REFUND-003).
   */
  /** What is left to refund on one payment, under its row lock (FR-REFUND-003). */
  async refundable(tx: Tx, paymentId: string, exceptRefundId?: string): Promise<number> {
    const [payment] = await tx.$queryRaw<{ captured_amount: number; refunded_amount: number }[]>`
      SELECT captured_amount, refunded_amount FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    if (!payment) throw new AppError('NOT_FOUND', { message: 'Payment not found.' });
    const open = await tx.refund.aggregate({
      where: {
        paymentId,
        status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] },
        ...(exceptRefundId ? { id: { not: exceptRefundId } } : {}),
      },
      _sum: { amount: true },
    });
    return payment.captured_amount - payment.refunded_amount - (open._sum.amount ?? 0);
  }

  private tooMuch(refundable: number) {
    return new AppError('REFUND_EXCEEDS_REFUNDABLE', {
      message: `At most ₹${(Math.max(0, refundable) / 100).toFixed(2)} can be refunded.`,
      details: [{ path: 'amount', code: 'REFUNDABLE', message: String(Math.max(0, refundable)) }],
    });
  }

  async create(tx: Tx, input: CreateRefundInput): Promise<Refund> {
    if (input.paymentId) {
      const refundable = await this.refundable(tx, input.paymentId);
      if (input.amount > refundable) throw this.tooMuch(refundable);
    }
    const requested = input.status === 'REQUESTED';
    return tx.refund.create({
      data: {
        orderId: input.orderId,
        paymentId: input.paymentId,
        amount: input.amount,
        destination: input.destination,
        reasonCode: input.reasonCode,
        note: input.note ?? null,
        initiatorType: input.initiatorType,
        initiatorId: input.initiatorId ?? null,
        costBearer: input.costBearer,
        status: requested ? 'REQUESTED' : 'APPROVED',
        nextAttemptAt: requested ? null : this.clock.now(),
        ...(input.items?.length ? { items: { create: input.items } } : {}),
      },
    });
  }

  /** API-ADM-086 (FR-REFUND-008): a REQUESTED refund is approved and queued. */
  async approve(refundId: string): Promise<Refund> {
    const moved = await this.prisma.refund.updateMany({
      where: { id: refundId, status: 'REQUESTED' },
      data: { status: 'APPROVED', nextAttemptAt: this.clock.now(), version: { increment: 1 } },
    });
    if (moved.count === 0) throw await this.stateConflict(refundId, 'waiting for approval');
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  /** API-ADM-087 (FR-REFUND-005): a FAILED refund goes back to the queue with fresh attempts. */
  async retry(refundId: string): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${refundId}::uuid FOR UPDATE`;
      const refund = await tx.refund.findUnique({ where: { id: refundId } });
      if (!refund) throw new AppError('NOT_FOUND', { message: "We couldn't find that refund." });
      if (refund.status !== 'FAILED') throw await this.stateConflict(refundId, 'failed');
      if (refund.paymentId) {
        const refundable = await this.refundable(tx, refund.paymentId, refund.id);
        if (refund.amount > refundable) throw this.tooMuch(refundable);
      }
      return tx.refund.update({
        where: { id: refundId },
        data: {
          status: 'APPROVED',
          attempts: 0,
          providerRefundId: null,
          nextAttemptAt: this.clock.now(),
          version: { increment: 1 },
        },
      });
    });
  }

  private async stateConflict(refundId: string, wanted: string) {
    const r = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: { status: true },
    });
    if (!r) return new AppError('NOT_FOUND', { message: "We couldn't find that refund." });
    return new AppError('REFUND_STATE_CONFLICT', {
      message: `Only a refund that is ${wanted} can do this; this one is ${r.status.toLowerCase()}.`,
      details: [{ code: 'CURRENT_STATUS', message: r.status }],
    });
  }

  /** Queues submission after the creating transaction commits; the sweeper covers a lost job. */
  async schedule(refundId: string): Promise<void> {
    await this.jobs
      .enqueue('refunds', SUBMIT_REFUND_JOB, { refundId }, { jobId: `refund-${refundId}` })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, refundId },
          'could not queue refund; the sweeper will pick it up',
        );
      });
  }

  /**
   * Who pays for a refund in the ledger (FR-REFUND-009): before settlement the
   * money still sits in the order's liability; afterwards — or once the
   * liability has already been given back, e.g. a goodwill refund on a
   * cancelled order — the cost bearer pays.
   */
  private async debitAccount(tx: Tx, refund: Refund): Promise<AccountRef> {
    const settled = await tx.ledgerTransaction.count({
      where: { type: 'ORDER_SETTLEMENT', referenceType: 'order', referenceId: refund.orderId },
    });
    const liability: AccountRef = {
      ownerType: 'ORDER',
      ownerId: refund.orderId,
      type: 'CUSTOMER_ORDER_LIABILITY',
    };
    if (!settled && (await this.ledger.balance(tx, liability)) >= refund.amount) return liability;
    if (refund.costBearer === 'RESTAURANT') {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: refund.orderId },
        select: { restaurantId: true },
      });
      return { ownerType: 'RESTAURANT', ownerId: order.restaurantId, type: 'RESTAURANT_PAYABLE' };
    }
    // Partner-caused costs are recovered only after dispute review, so the platform carries them first.
    return { ownerType: 'PLATFORM', ownerId: null, type: 'PLATFORM_REFUND_EXPENSE' };
  }

  /** JOB-REFUND-001: one submission attempt. */
  async submit(refundId: string): Promise<void> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { payment: { include: { attempts: true } } },
    });
    if (!refund || refund.status !== 'APPROVED') return;

    if (refund.destination === 'WALLET') {
      const order = await this.prisma.order.findUniqueOrThrow({
        where: { id: refund.orderId },
        select: { userId: true },
      });
      await this.prisma.$transaction(async (tx) => {
        const moved = await tx.refund.updateMany({
          where: { id: refund.id, status: 'APPROVED' },
          data: { status: 'SUCCEEDED', completedAt: this.clock.now(), attempts: { increment: 1 } },
        });
        if (moved.count === 0) return;
        await this.wallet.credit(tx, {
          userId: order.userId,
          amount: refund.amount,
          source: 'REFUND',
          referenceType: 'refund',
          referenceId: refund.id,
          description: 'Refund to wallet',
          from: await this.debitAccount(tx, refund),
        });
        await writeOutbox(tx, {
          aggregateType: 'refund',
          aggregateId: refund.id,
          aggregateVersion: refund.version + 1,
          eventType: 'refund.succeeded',
          payload: { orderId: refund.orderId, amount: refund.amount, destination: 'WALLET' },
        });
      });
      return;
    }

    const captured = refund.payment?.attempts.find(
      (a) => a.status === 'CAPTURED' && a.providerPaymentId,
    );
    if (!refund.payment || !captured?.providerPaymentId) {
      await this.giveUp(refund, 'No captured payment to refund');
      return;
    }
    try {
      const result = await this.provider.refund({
        providerPaymentId: captured.providerPaymentId,
        amount: refund.amount,
        refundId: refund.id,
      });
      await this.prisma.refund.update({
        where: { id: refund.id },
        data: {
          status: 'PROCESSING',
          providerRefundId: result.providerRefundId,
          attempts: { increment: 1 },
          nextAttemptAt: null,
          version: { increment: 1 },
        },
      });
      if (result.status !== 'PENDING') await this.applyProviderRefund(result);
    } catch (error) {
      const attempts = refund.attempts + 1;
      this.logger.warn({ err: error, refundId: refund.id, attempts }, 'refund submission failed');
      if (
        attempts >= BACKOFF_MINUTES.length ||
        (error instanceof ProviderError && error.status === 400)
      ) {
        await this.prisma.refund.update({ where: { id: refund.id }, data: { attempts } });
        await this.giveUp(refund, error instanceof Error ? error.message : 'provider error');
      } else {
        await this.prisma.refund.update({
          where: { id: refund.id },
          data: {
            attempts,
            nextAttemptAt: new Date(
              this.clock.now().getTime() + BACKOFF_MINUTES[attempts - 1]! * 60_000,
            ),
          },
        });
      }
    }
  }

  /** Permanent failure: marked FAILED and handed to operations (FR-REFUND-005 fallback is decided there). */
  private async giveUp(refund: Refund, reason: string): Promise<void> {
    await this.prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: 'FAILED',
        note: `${refund.note ?? ''} [failed: ${reason}]`.trim().slice(0, 500),
      },
    });
    await raiseOpsAlert(this.prisma, {
      type: 'REFUND_FAILED',
      severity: 'CRITICAL',
      refType: 'refund',
      refId: refund.id,
      message: `Refund of ₹${(refund.amount / 100).toFixed(2)} for order ${refund.orderId} failed: ${reason}`,
      dedupeKey: `refund-failed:${refund.id}`,
    });
  }

  /** Provider confirmation (webhook or poll, FR-REFUND-006). Idempotent. */
  async applyProviderRefund(pr: ProviderRefund): Promise<'APPLIED' | 'IGNORED'> {
    const refund = await this.prisma.refund.findUnique({
      where: { providerRefundId: pr.providerRefundId },
    });
    if (!refund || refund.status !== 'PROCESSING' || pr.status === 'PENDING') return 'IGNORED';
    if (pr.status === 'FAILED') {
      const retry = refund.attempts < BACKOFF_MINUTES.length;
      await this.prisma.refund.update({
        where: { id: refund.id },
        data: retry
          ? {
              status: 'APPROVED',
              providerRefundId: null,
              nextAttemptAt: new Date(
                this.clock.now().getTime() +
                  BACKOFF_MINUTES[Math.max(0, refund.attempts - 1)]! * 60_000,
              ),
            }
          : { status: 'FAILED' },
      });
      if (!retry) await this.giveUp(refund, 'provider reported failure');
      return 'APPLIED';
    }
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.refund.updateMany({
        where: { id: refund.id, status: 'PROCESSING' },
        data: { status: 'SUCCEEDED', completedAt: this.clock.now(), version: { increment: 1 } },
      });
      if (moved.count === 0 || !refund.paymentId) return;
      const [payment] = await tx.$queryRaw<
        { status: string; captured_amount: number; refunded_amount: number; version: number }[]
      >`
        SELECT status::text AS status, captured_amount, refunded_amount, version FROM payments WHERE id = ${refund.paymentId}::uuid FOR UPDATE`;
      const refunded = payment!.refunded_amount + refund.amount;
      const next = refunded >= payment!.captured_amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await tx.payment.update({
        where: { id: refund.paymentId },
        data: {
          refundedAmount: refunded,
          ...(canTransition(payment!.status as never, next) ? { status: next } : {}),
          version: { increment: 1 },
        },
      });
      await this.ledger.post(tx, {
        type: 'REFUND',
        referenceType: 'refund',
        referenceId: refund.id,
        description: `Refund ${refund.reasonCode}`,
        entries: [
          { ...(await this.debitAccount(tx, refund)), amount: refund.amount },
          {
            ownerType: 'PLATFORM',
            ownerId: null,
            type: 'GATEWAY_CLEARING',
            amount: -refund.amount,
          },
        ],
      });
      await writeOutbox(tx, {
        aggregateType: 'refund',
        aggregateId: refund.id,
        aggregateVersion: refund.version + 1,
        eventType: 'refund.succeeded',
        payload: { orderId: refund.orderId, amount: refund.amount, destination: 'SOURCE' },
      });
    });
    return 'APPLIED';
  }

  /** Sweeper: due submissions, and PROCESSING refunds still unconfirmed after an hour (JOB-REFUND-002). */
  async sweep(limit = 50): Promise<{ submitted: number; polled: number }> {
    const now = this.clock.now();
    const due = await this.prisma.refund.findMany({
      where: { status: 'APPROVED', nextAttemptAt: { lte: now } },
      take: limit,
      select: { id: true },
    });
    for (const r of due) await this.submit(r.id);
    const stale = await this.prisma.refund.findMany({
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: new Date(now.getTime() - 3_600_000) },
        providerRefundId: { not: null },
      },
      take: limit,
      select: { providerRefundId: true },
    });
    for (const r of stale) {
      try {
        await this.applyProviderRefund(await this.provider.getRefund(r.providerRefundId!));
      } catch (error) {
        this.logger.warn({ err: error }, 'refund status poll failed');
      }
    }
    return { submitted: due.length, polled: stale.length };
  }

  /** API-REF-001 / 002 */
  async listForUser(userId: string) {
    return this.prisma.refund.findMany({
      where: { order: { userId } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        orderId: true,
        amount: true,
        destination: true,
        status: true,
        reasonCode: true,
        createdAt: true,
        completedAt: true,
      },
    });
  }

  async getForUser(userId: string, refundId: string) {
    const refund = await this.prisma.refund.findFirst({
      where: { id: refundId, order: { userId } },
      select: {
        id: true,
        orderId: true,
        paymentId: true,
        amount: true,
        destination: true,
        status: true,
        reasonCode: true,
        createdAt: true,
        completedAt: true,
      },
    });
    if (!refund) throw new AppError('NOT_FOUND', { message: "We couldn't find that refund." });
    return refund;
  }
}
