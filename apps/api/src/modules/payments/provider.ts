import { createHmac, timingSafeEqual } from 'node:crypto';

/** Provider-agnostic payment states the payments service understands. */
export type ProviderPaymentStatus = 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED';

export interface ProviderPayment {
  providerPaymentId: string;
  providerOrderId: string | null;
  amount: number;
  currency: string;
  status: ProviderPaymentStatus;
  /** e.g. "UPI • ab***@okicici", "Visa •• 4242" (FR-PAY-015). */
  instrumentSummary: string | null;
  method: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

export interface ProviderRefund {
  providerRefundId: string;
  providerPaymentId: string;
  amount: number;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
}

/** Canonical events (PAYMENT-ARCHITECTURE §2): adding a provider means a new adapter, not new business logic. */
export type CanonicalEventType =
  | 'PAYMENT_AUTHORIZED'
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_FAILED'
  | 'ORDER_PAID'
  | 'REFUND_PROCESSED'
  | 'REFUND_FAILED'
  | 'UNKNOWN';

export interface NormalizedEvent {
  eventId: string;
  rawType: string;
  type: CanonicalEventType;
  occurredAt: Date;
  payment: ProviderPayment | null;
  refund: ProviderRefund | null;
}

/** FR-PAY-001 */
export interface PaymentProvider {
  readonly name: 'RAZORPAY' | 'MOCK';
  /** Public key the client SDK needs (never a secret). */
  readonly keyId: string;
  createPaymentOrder(input: {
    amount: number;
    currency: 'INR';
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ providerOrderId: string }>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  /** Client callback check, no network (FR-PAY-003). */
  verifyClientSignature(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): boolean;
  /** Signature over the raw body; accepts any configured secret during rotation (FR-PAY-014). */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): NormalizedEvent;
  refund(input: {
    providerPaymentId: string;
    amount: number;
    refundId: string;
  }): Promise<ProviderRefund>;
  getRefund(providerRefundId: string): Promise<ProviderRefund>;
}

/** Provider call failed (network, 5xx, unexpected response). */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const hmacHex = (secret: string, message: string | Buffer) =>
  createHmac('sha256', secret).update(message).digest('hex');

/** Constant-time comparison of hex signatures. */
export function signatureMatches(expectedHex: string, given: string | undefined): boolean {
  if (!given || !/^[0-9a-f]+$/i.test(given)) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(given, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ----------------- Razorpay-shaped payloads (also used by the mock) ----------------- */

interface RzpPaymentEntity {
  id: string;
  order_id?: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string;
  vpa?: string;
  card?: { last4?: string; network?: string };
  bank?: string;
  wallet?: string;
  error_code?: string | null;
  error_description?: string | null;
}

interface RzpRefundEntity {
  id: string;
  payment_id: string;
  amount: number;
  status: string;
}

const maskVpa = (vpa: string) => {
  const [user = '', host = ''] = vpa.split('@');
  return `${user.slice(0, 2)}***@${host}`;
};

export function instrumentOf(p: RzpPaymentEntity): string | null {
  switch (p.method) {
    case 'upi':
      return p.vpa ? `UPI • ${maskVpa(p.vpa)}` : 'UPI';
    case 'card':
      return p.card?.last4 ? `${p.card.network ?? 'Card'} •• ${p.card.last4}` : 'Card';
    case 'netbanking':
      return `Netbanking${p.bank ? ` • ${p.bank}` : ''}`;
    case 'wallet':
      return `Wallet${p.wallet ? ` • ${p.wallet}` : ''}`;
    default:
      return p.method ?? null;
  }
}

export function toProviderPayment(p: RzpPaymentEntity): ProviderPayment {
  const status: ProviderPaymentStatus =
    p.status === 'captured' || p.status === 'refunded'
      ? 'CAPTURED'
      : p.status === 'authorized'
        ? 'AUTHORIZED'
        : p.status === 'failed'
          ? 'FAILED'
          : 'PENDING';
  return {
    providerPaymentId: p.id,
    providerOrderId: p.order_id ?? null,
    amount: p.amount,
    currency: p.currency,
    status,
    instrumentSummary: instrumentOf(p),
    method: p.method ?? null,
    errorCode: p.error_code ?? null,
    errorDescription: p.error_description ?? null,
  };
}

export function toProviderRefund(r: RzpRefundEntity): ProviderRefund {
  return {
    providerRefundId: r.id,
    providerPaymentId: r.payment_id,
    amount: r.amount,
    status: r.status === 'processed' ? 'PROCESSED' : r.status === 'failed' ? 'FAILED' : 'PENDING',
  };
}

const EVENT_TYPES: Record<string, CanonicalEventType> = {
  'payment.authorized': 'PAYMENT_AUTHORIZED',
  'payment.captured': 'PAYMENT_CAPTURED',
  'payment.failed': 'PAYMENT_FAILED',
  'order.paid': 'ORDER_PAID',
  'refund.processed': 'REFUND_PROCESSED',
  'refund.failed': 'REFUND_FAILED',
};

/** Razorpay webhook body → canonical event. The event id comes from the `x-razorpay-event-id` header. */
export function parseRazorpayStyle(raw: Buffer, eventId: string | undefined): NormalizedEvent {
  const body = JSON.parse(raw.toString('utf8')) as {
    event: string;
    created_at?: number;
    payload?: { payment?: { entity: RzpPaymentEntity }; refund?: { entity: RzpRefundEntity } };
  };
  const payment = body.payload?.payment?.entity;
  const refund = body.payload?.refund?.entity;
  return {
    eventId:
      eventId ?? `${body.event}:${payment?.id ?? refund?.id ?? 'unknown'}:${body.created_at ?? 0}`,
    rawType: body.event,
    type: EVENT_TYPES[body.event] ?? 'UNKNOWN',
    occurredAt: new Date((body.created_at ?? Math.floor(Date.now() / 1000)) * 1000),
    payment: payment ? toProviderPayment(payment) : null,
    refund: refund ? toProviderRefund(refund) : null,
  };
}
