import type { Payment, PaymentAttemptStatus, PaymentStatus, Prisma, PrismaClient } from '@fos/db';
import { uuidv7 } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { JobQueue } from '../../platform/jobs';
import type { Logger } from '../../platform/logger';
import { raiseOpsAlert } from '../../platform/ops-alerts';
import { writeOutbox } from '../../platform/outbox';
import { decodeCursor, encodeCursor, queryFingerprint } from '../../platform/pagination';
import type { AuditService } from '../audit';
import type { LedgerService } from '../ledger';
import {
  ProviderError,
  type NormalizedEvent,
  type PaymentProvider,
  type ProviderPayment,
  parseRazorpayStyle,
} from './provider';
import type { RefundService } from './refunds.service';
import { canTransition } from './status';

type Tx = Prisma.TransactionClient;

export const PROCESS_WEBHOOK_JOB = 'process-webhook';
const MAX_ATTEMPTS = 5; // BR-PAY-006
const TERMINAL_ORDER = new Set(['FAILED', 'CANCELLED']);

export interface PaymentView {
  id: string;
  orderId: string;
  method: string;
  provider: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  capturedAmount: number;
  refundedAmount: number;
  instrumentSummary: string | null;
  failureReason: string | null;
  createdAt: Date;
  capturedAt: Date | null;
}

const view = (p: Payment): PaymentView => ({
  id: p.id,
  orderId: p.orderId,
  method: p.method,
  provider: p.provider,
  amount: p.amount,
  currency: p.currency,
  status: p.status,
  capturedAmount: p.capturedAmount,
  refundedAmount: p.refundedAmount,
  instrumentSummary: p.instrumentSummary,
  failureReason: p.failureReason,
  createdAt: p.createdAt,
  capturedAt: p.capturedAt,
});

/**
 * Online payments (FR-PAY-001…009, 014, 015; BR-PAY-003…006). Success is only
 * ever decided from the provider (signature + fetch, or a verified webhook).
 * Order transitions consume the outbox events written here (Phase 7).
 */
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly refunds: RefundService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** API-PAY-002 / FR-PAY-002, 005: create or reuse the provider order; every call is a new attempt. */
  async initiate(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { user: { select: { fullName: true, phone: true, email: true } } },
    });
    if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    if (order.status !== 'PAYMENT_PENDING')
      throw new AppError('ORDER_STATE_CONFLICT', {
        message: 'This order is not waiting for payment.',
      });
    if (order.paymentMethod !== 'ONLINE' || order.payableAmount <= 0) {
      throw new AppError('VALIDATION_ERROR', { message: 'This order has nothing to pay online.' });
    }
    const attempts = await this.prisma.paymentAttempt.count({ where: { payment: { orderId } } });
    if (attempts >= MAX_ATTEMPTS) throw new AppError('PAYMENT_ATTEMPTS_EXCEEDED');

    let payment =
      (await this.prisma.payment.findFirst({
        where: { orderId, provider: this.provider.name, status: { in: ['CREATED', 'PENDING'] } },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.payment.create({
        data: {
          orderId,
          method: 'ONLINE',
          provider: this.provider.name,
          amount: order.payableAmount,
          status: 'CREATED',
        },
      }));
    if (!payment.providerOrderId) {
      try {
        const { providerOrderId } = await this.provider.createPaymentOrder({
          amount: payment.amount,
          currency: 'INR',
          receipt: order.number,
          notes: { paymentId: payment.id, orderId },
        });
        payment = await this.prisma.payment.update({
          where: { id: payment.id },
          data: { providerOrderId, status: 'PENDING', version: { increment: 1 } },
        });
      } catch (error) {
        this.logger.warn({ err: error, paymentId: payment.id }, 'payment order creation failed');
        throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE', { retryable: true, cause: error });
      }
    }
    await this.prisma.paymentAttempt.create({
      data: { paymentId: payment.id, amount: payment.amount, status: 'CREATED' },
    });
    // Only public parameters: never a secret (FR-PAY-002).
    return {
      paymentId: payment.id,
      provider: this.provider.name,
      keyId: this.provider.keyId,
      providerOrderId: payment.providerOrderId!,
      amount: payment.amount,
      currency: 'INR',
      orderNumber: order.number,
      prefill: { name: order.user.fullName, contact: order.user.phone, email: order.user.email },
    };
  }

  private async owned(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, order: { userId } },
    });
    if (!payment) throw new AppError('NOT_FOUND', { message: "We couldn't find that payment." });
    return payment;
  }

  /** API-PAY-004 / FR-PAY-003: signature first, then the provider's own record decides. */
  async verify(
    userId: string,
    paymentId: string,
    input: { providerPaymentId: string; signature: string },
    meta: { ip?: string | null; requestId?: string },
  ) {
    const payment = await this.owned(userId, paymentId);
    if (!payment.providerOrderId) throw new AppError('PAYMENT_ORDER_MISMATCH');
    if (
      !this.provider.verifyClientSignature({ providerOrderId: payment.providerOrderId, ...input })
    ) {
      await this.audit.record({
        action: 'payment.signature_invalid',
        targetType: 'payment',
        targetId: payment.id,
        actorUserId: userId,
        ip: meta.ip ?? null,
        requestId: meta.requestId,
        sensitivity: 'HIGH',
      });
      throw new AppError('PAYMENT_SIGNATURE_INVALID');
    }
    let providerPayment: ProviderPayment;
    try {
      providerPayment = await this.provider.getPayment(input.providerPaymentId);
    } catch (error) {
      throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE', { retryable: true, cause: error });
    }
    if (providerPayment.providerOrderId !== payment.providerOrderId)
      throw new AppError('PAYMENT_ORDER_MISMATCH');
    await this.apply(payment.id, providerPayment, 'client_verify');
    return view(await this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }));
  }

  /**
   * Applies the provider's view of a payment under a row lock (one writer per
   * payment), honouring precedence (FR-PAY-009) and amount integrity (FR-PAY-008).
   */
  async apply(
    paymentId: string,
    pp: ProviderPayment,
    source: 'client_verify' | 'webhook' | 'poll',
  ): Promise<'APPLIED' | 'IGNORED'> {
    const scheduleRefunds: string[] = [];
    const outcome = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
      if (!locked) return 'IGNORED' as const;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: { select: { id: true, status: true, number: true } } },
      });
      await this.recordAttempt(tx, payment.id, pp);

      const incoming: PaymentStatus = pp.status;
      if (!canTransition(payment.status, incoming)) {
        this.logger.info(
          { paymentId, from: payment.status, to: incoming, source },
          'payment update ignored by precedence',
        );
        return 'IGNORED' as const;
      }

      if (incoming === 'CAPTURED') {
        const mismatch = pp.amount !== payment.amount || pp.currency !== payment.currency;
        if (mismatch && pp.amount > payment.amount) {
          // Can't be represented (captured > expected): hand to operations untouched.
          await raiseOpsAlert(tx, {
            type: 'PAYMENT_OVERCAPTURE',
            severity: 'CRITICAL',
            refType: 'payment',
            refId: payment.id,
            message: `Provider captured ${pp.amount} ${pp.currency} for payment expecting ${payment.amount}.`,
            dedupeKey: `overcapture:${payment.id}`,
          });
          return 'IGNORED' as const;
        }
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'CAPTURED',
            capturedAmount: pp.amount,
            capturedAt: this.clock.now(),
            instrumentSummary: pp.instrumentSummary,
            ...(mismatch
              ? {
                  failureCode: 'AMOUNT_MISMATCH',
                  failureReason: `Captured ${pp.amount} instead of ${payment.amount}`,
                }
              : {}),
            version: { increment: 1 },
          },
        });
        // The money is at the gateway either way (ADR-011).
        await this.ledger.post(tx, {
          type: 'ORDER_PAYMENT',
          referenceType: 'payment',
          referenceId: payment.id,
          description: `Online payment for order ${payment.order.number}`,
          entries: [
            { ownerType: 'PLATFORM', ownerId: null, type: 'GATEWAY_CLEARING', amount: pp.amount },
            {
              ownerType: 'ORDER',
              ownerId: payment.orderId,
              type: 'CUSTOMER_ORDER_LIABILITY',
              amount: -pp.amount,
            },
          ],
        });
        const terminal = TERMINAL_ORDER.has(payment.order.status);
        if (mismatch || terminal) {
          // FR-PAY-008 / BR-PAY-005: never advance the order; refund in full.
          const refund = await this.refunds.create(tx, {
            orderId: payment.orderId,
            paymentId: payment.id,
            amount: pp.amount,
            destination: 'SOURCE',
            reasonCode: mismatch ? 'AMOUNT_MISMATCH' : 'LATE_CAPTURE',
            initiatorType: 'SYSTEM',
            costBearer: 'PLATFORM',
          });
          scheduleRefunds.push(refund.id);
          await raiseOpsAlert(tx, {
            type: mismatch ? 'PAYMENT_AMOUNT_MISMATCH' : 'PAYMENT_LATE_CAPTURE',
            severity: mismatch ? 'CRITICAL' : 'WARNING',
            refType: 'payment',
            refId: payment.id,
            message: mismatch
              ? `Payment ${payment.id} captured ${pp.amount} but ${payment.amount} was expected; refunded.`
              : `Payment ${payment.id} was captured after order ${payment.order.number} became ${payment.order.status}; refunded.`,
            dedupeKey: `${mismatch ? 'mismatch' : 'late'}:${payment.id}`,
          });
        }
        await writeOutbox(tx, {
          aggregateType: 'payment',
          aggregateId: payment.id,
          aggregateVersion: payment.version + 1,
          eventType: mismatch
            ? 'payment.amount_mismatch'
            : terminal
              ? 'payment.late_capture'
              : 'payment.captured',
          payload: { orderId: payment.orderId, amount: pp.amount, source },
        });
        return 'APPLIED' as const;
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: incoming,
          ...(incoming === 'FAILED'
            ? { failureCode: pp.errorCode, failureReason: pp.errorDescription }
            : {}),
          instrumentSummary: pp.instrumentSummary ?? payment.instrumentSummary,
          version: { increment: 1 },
        },
      });
      await writeOutbox(tx, {
        aggregateType: 'payment',
        aggregateId: payment.id,
        aggregateVersion: payment.version + 1,
        eventType: `payment.${incoming.toLowerCase()}`,
        payload: { orderId: payment.orderId, source },
      });
      return 'APPLIED' as const;
    });
    for (const id of scheduleRefunds) await this.refunds.schedule(id);
    return outcome;
  }

  /** Links the provider payment to an attempt (attempt facts are immutable; status may progress). */
  private async recordAttempt(tx: Tx, paymentId: string, pp: ProviderPayment): Promise<void> {
    const status: PaymentAttemptStatus = pp.status === 'PENDING' ? 'CREATED' : pp.status;
    const data = {
      status,
      methodDetail: pp.method?.slice(0, 40) ?? null,
      errorCode: pp.errorCode?.slice(0, 60) ?? null,
      raw: pp as unknown as Prisma.InputJsonValue,
    };
    const existing = await tx.paymentAttempt.findUnique({
      where: { providerPaymentId: pp.providerPaymentId },
    });
    if (existing) {
      if (canTransition(existing.status as PaymentStatus, status as PaymentStatus))
        await tx.paymentAttempt.update({ where: { id: existing.id }, data });
      return;
    }
    const open = await tx.paymentAttempt.findFirst({
      where: { paymentId, providerPaymentId: null },
      orderBy: { createdAt: 'desc' },
    });
    if (open && open.amount === pp.amount) {
      await tx.paymentAttempt.update({
        where: { id: open.id },
        data: { ...data, providerPaymentId: pp.providerPaymentId },
      });
    } else {
      await tx.paymentAttempt.create({
        data: { paymentId, amount: pp.amount, providerPaymentId: pp.providerPaymentId, ...data },
      });
    }
  }

  /* ----------------------------- webhooks (FR-PAY-004) ----------------------------- */

  /** Verifies, stores once, queues. Never processes inline, so it answers well within 2 s. */
  async ingestWebhook(
    providerName: string,
    raw: Buffer,
    headers: Record<string, string | undefined>,
    ip: string | null,
  ) {
    if (providerName.toUpperCase() !== this.provider.name) throw new AppError('NOT_FOUND');
    if (!this.provider.verifyWebhook(raw, headers)) {
      this.logger.warn({ provider: providerName, ip }, 'payment webhook with an invalid signature');
      await this.audit.record({
        action: 'payment.webhook_signature_invalid',
        targetType: 'webhook',
        ip,
        sensitivity: 'HIGH',
      });
      throw new AppError('PAYMENT_SIGNATURE_INVALID', { status: 401 });
    }
    let event: NormalizedEvent;
    try {
      event = this.provider.parseWebhook(raw, headers);
    } catch {
      throw new AppError('VALIDATION_ERROR', { message: 'Unreadable webhook body.' });
    }
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO payment_webhook_events (id, provider, event_id, event_type, signature_valid, payload, processing_status)
      VALUES (${uuidv7()}::uuid, ${this.provider.name}::"PaymentProvider", ${event.eventId.slice(0, 100)}, ${event.rawType.slice(0, 60)}, true,
        ${raw.toString('utf8')}::jsonb, 'RECEIVED')
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING id`;
    const row = rows[0];
    if (!row) return { duplicate: true }; // BR-PAY-004
    await this.jobs
      .enqueue(
        'payments',
        PROCESS_WEBHOOK_JOB,
        { eventRowId: row.id },
        { jobId: `webhook-${row.id}` },
      )
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'could not queue webhook; the sweeper will process it');
      });
    return { duplicate: false };
  }

  /** JOB-PAY-001 */
  async processWebhook(eventRowId: string): Promise<void> {
    const row = await this.prisma.paymentWebhookEvent.findUnique({ where: { id: eventRowId } });
    if (!row || row.processingStatus !== 'RECEIVED') return;
    const finish = (processingStatus: 'PROCESSED' | 'IGNORED' | 'FAILED', error?: string) =>
      this.prisma.paymentWebhookEvent.update({
        where: { id: row.id },
        data: {
          processingStatus,
          processedAt: this.clock.now(),
          error: error?.slice(0, 500) ?? null,
        },
      });
    try {
      const event = parseRazorpayStyle(Buffer.from(JSON.stringify(row.payload)), row.eventId);
      if (
        event.payment &&
        (event.type === 'PAYMENT_CAPTURED' ||
          event.type === 'PAYMENT_FAILED' ||
          event.type === 'PAYMENT_AUTHORIZED')
      ) {
        const payment = event.payment.providerOrderId
          ? await this.prisma.payment.findFirst({
              where: { provider: row.provider, providerOrderId: event.payment.providerOrderId },
            })
          : null;
        if (!payment) {
          if (event.payment.status === 'CAPTURED') {
            await raiseOpsAlert(this.prisma, {
              type: 'PAYMENT_ORPHAN_CAPTURE',
              severity: 'CRITICAL',
              refType: 'webhook',
              refId: row.id,
              message: `Capture ${event.payment.providerPaymentId} matches no payment; refund it at the provider.`,
              dedupeKey: `orphan:${event.payment.providerPaymentId}`,
            });
          }
          await finish('IGNORED', 'unknown payment');
          return;
        }
        await finish(
          (await this.apply(payment.id, event.payment, 'webhook')) === 'APPLIED'
            ? 'PROCESSED'
            : 'IGNORED',
        );
        return;
      }
      if (event.refund && (event.type === 'REFUND_PROCESSED' || event.type === 'REFUND_FAILED')) {
        await finish(
          (await this.refunds.applyProviderRefund(event.refund)) === 'APPLIED'
            ? 'PROCESSED'
            : 'IGNORED',
        );
        return;
      }
      await finish('IGNORED', `not handled: ${event.rawType}`);
    } catch (error) {
      await finish('FAILED', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Sweeper for events whose job was lost (queue down at ingest). */
  async processPendingWebhooks(olderThanMs = 30_000, limit = 100): Promise<number> {
    const rows = await this.prisma.paymentWebhookEvent.findMany({
      where: {
        processingStatus: 'RECEIVED',
        receivedAt: { lt: new Date(this.clock.now().getTime() - olderThanMs) },
      },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    for (const r of rows)
      await this.processWebhook(r.id).catch((error: unknown) =>
        this.logger.error({ err: error, eventRowId: r.id }, 'webhook processing failed'),
      );
    return rows.length;
  }

  /** FR-RECON-004: payments stuck PENDING/AUTHORIZED for 30 min are resolved from the provider. */
  async resolveStuck(limit = 50): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - 30 * 60_000);
    const stuck = await this.prisma.payment.findMany({
      where: {
        status: { in: ['PENDING', 'AUTHORIZED'] },
        updatedAt: { lt: cutoff },
        provider: this.provider.name,
      },
      include: { attempts: { where: { providerPaymentId: { not: null } } } },
      take: limit,
    });
    let resolved = 0;
    for (const p of stuck) {
      for (const a of p.attempts) {
        try {
          if (
            (await this.apply(
              p.id,
              await this.provider.getPayment(a.providerPaymentId!),
              'poll',
            )) === 'APPLIED'
          )
            resolved += 1;
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          this.logger.warn({ err: error, paymentId: p.id }, 'payment status poll failed');
        }
      }
    }
    return resolved;
  }

  /**
   * JOB-ORD-001 (FR-PAY-006): before expiring an order, ask the provider about
   * every payment made against its provider orders, so a capture whose callback
   * and webhook were both lost still places the order.
   */
  async pollOrder(orderId: string): Promise<void> {
    const open = await this.prisma.payment.findMany({
      where: {
        orderId,
        status: { in: ['CREATED', 'PENDING', 'AUTHORIZED'] },
        provider: this.provider.name,
        providerOrderId: { not: null },
      },
    });
    for (const p of open) {
      let found: ProviderPayment[];
      try {
        found = await this.provider.listOrderPayments(p.providerOrderId!);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        // Can't confirm with the provider: don't expire on a guess; the job retries.
        throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE', { retryable: true, cause: error });
      }
      // Captures first, so a failed attempt never masks a later success.
      found.sort((a, b) => Number(b.status === 'CAPTURED') - Number(a.status === 'CAPTURED'));
      for (const pp of found) await this.apply(p.id, pp, 'poll');
    }
  }

  /** T04/T05: open payments of a dead order become EXPIRED / CANCELLED (never after capture). */
  async closeOpenPayments(tx: Tx, orderId: string, to: 'EXPIRED' | 'CANCELLED'): Promise<void> {
    const open = await tx.payment.findMany({
      where: { orderId, status: { in: ['CREATED', 'PENDING', 'AUTHORIZED'] } },
    });
    for (const p of open) {
      if (canTransition(p.status, to))
        await tx.payment.update({
          where: { id: p.id },
          data: { status: to, version: { increment: 1 } },
        });
    }
  }

  /* ----------------------------- reads ----------------------------- */

  /** API-PAY-003 */
  async get(userId: string, paymentId: string): Promise<PaymentView> {
    return view(await this.owned(userId, paymentId));
  }

  /** API-PAY-006 */
  async history(userId: string, opts: { limit: number; cursor?: string | undefined }) {
    const context = queryFingerprint(['payments', userId]);
    const after = opts.cursor ? decodeCursor(opts.cursor, context) : null;
    const rows = await this.prisma.payment.findMany({
      where: {
        order: { userId },
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
      items: page.map(view),
      nextCursor:
        rows.length > opts.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }
}
