import { randomBytes } from 'node:crypto';
import {
  hmacHex,
  parseRazorpayStyle,
  ProviderError,
  signatureMatches,
  toProviderPayment,
  toProviderRefund,
  type NormalizedEvent,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderRefund,
} from './provider';

/** PAYMENT-ARCHITECTURE §8: outcomes chosen per payment, for development and tests. */
export type MockScenario = 'success' | 'fail' | 'authorize_only' | 'amount_mismatch';

interface MockWebhook {
  body: Buffer;
  headers: Record<string, string>;
}

const id = (prefix: string) => `${prefix}_mock_${randomBytes(7).toString('hex')}`;

/**
 * In-memory provider with Razorpay-shaped payloads and real HMAC signatures,
 * so the verification, webhook and precedence code paths are the same ones
 * production uses. Never available in production (env.ts).
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'MOCK' as const;
  readonly keyId = 'rzp_mock_key';
  /** When set, createPaymentOrder fails (simulates a provider outage). */
  down = false;
  private readonly orders = new Map<
    string,
    { amount: number; currency: string; receipt: string }
  >();
  private readonly payments = new Map<string, Record<string, unknown>>();
  private readonly refunds = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  async createPaymentOrder(input: {
    amount: number;
    currency: 'INR';
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<{ providerOrderId: string }> {
    if (this.down) throw new ProviderError('mock provider unavailable', 503);
    const providerOrderId = id('order');
    this.orders.set(providerOrderId, {
      amount: input.amount,
      currency: input.currency,
      receipt: input.receipt,
    });
    return { providerOrderId };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const p = this.payments.get(providerPaymentId);
    if (!p) throw new ProviderError('payment not found', 404, 'BAD_REQUEST_ERROR');
    return toProviderPayment(p as never);
  }

  verifyClientSignature(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): boolean {
    return signatureMatches(
      hmacHex(this.keySecret, `${input.providerOrderId}|${input.providerPaymentId}`),
      input.signature,
    );
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    return signatureMatches(hmacHex(this.webhookSecret, rawBody), headers['x-razorpay-signature']);
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): NormalizedEvent {
    return parseRazorpayStyle(rawBody, headers['x-razorpay-event-id']);
  }

  async refund(input: {
    providerPaymentId: string;
    amount: number;
    refundId: string;
  }): Promise<ProviderRefund> {
    if (this.down) throw new ProviderError('mock provider unavailable', 503);
    const refund = {
      id: id('rfnd'),
      payment_id: input.providerPaymentId,
      amount: input.amount,
      status: 'pending',
    };
    this.refunds.set(refund.id, refund);
    return toProviderRefund(refund as never);
  }

  async getRefund(providerRefundId: string): Promise<ProviderRefund> {
    const r = this.refunds.get(providerRefundId);
    if (!r) throw new ProviderError('refund not found', 404);
    return toProviderRefund(r as never);
  }

  /* ----------------------------- simulation helpers ----------------------------- */

  /** The customer completes hosted checkout: returns what the client SDK would, plus the webhook the provider would send. */
  pay(providerOrderId: string, scenario: MockScenario = 'success', vpa = 'asha.rao@okicici') {
    const order = this.orders.get(providerOrderId);
    if (!order) throw new ProviderError('order not found', 404);
    const status =
      scenario === 'fail' ? 'failed' : scenario === 'authorize_only' ? 'authorized' : 'captured';
    const entity = {
      id: id('pay'),
      entity: 'payment',
      order_id: providerOrderId,
      amount: scenario === 'amount_mismatch' ? order.amount - 100 : order.amount,
      currency: order.currency,
      status,
      method: 'upi',
      vpa,
      ...(scenario === 'fail'
        ? { error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment was declined by the bank' }
        : {}),
    };
    this.payments.set(entity.id, entity);
    return {
      providerPaymentId: entity.id,
      signature: hmacHex(this.keySecret, `${providerOrderId}|${entity.id}`),
      webhook: this.webhook(`payment.${status}`, { payment: { entity } }),
    };
  }

  /** The provider finishes a refund. */
  settleRefund(
    providerRefundId: string,
    outcome: 'processed' | 'failed' = 'processed',
  ): MockWebhook {
    const refund = this.refunds.get(providerRefundId);
    if (!refund) throw new ProviderError('refund not found', 404);
    refund.status = outcome;
    return this.webhook(`refund.${outcome}`, { refund: { entity: refund } });
  }

  webhook(
    event: string,
    payload: Record<string, unknown>,
    secret = this.webhookSecret,
  ): MockWebhook {
    const body = Buffer.from(
      JSON.stringify({
        entity: 'event',
        event,
        payload,
        created_at: Math.floor(Date.now() / 1000),
      }),
    );
    return {
      body,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': hmacHex(secret, body),
        'x-razorpay-event-id': id('evt'),
      },
    };
  }
}
