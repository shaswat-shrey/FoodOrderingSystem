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

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  /** Several during rotation; any one may sign (FR-PAY-014). */
  webhookSecrets: string[];
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Razorpay adapter (hosted checkout; PCI scope stays with the provider, C-10).
 * Auto-capture must be enabled on the Razorpay account (FR-PAY-010).
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'RAZORPAY' as const;
  readonly keyId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: RazorpayConfig) {
    this.keyId = config.keyId;
    this.baseUrl = config.baseUrl ?? 'https://api.razorpay.com/v1';
    this.fetchImpl = config.fetch ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64')}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new ProviderError(`razorpay ${method} ${path} failed: ${(error as Error).message}`);
    }
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const err = json.error as { code?: string; description?: string } | undefined;
      throw new ProviderError(
        err?.description ?? `razorpay ${response.status}`,
        response.status,
        err?.code,
      );
    }
    return json as T;
  }

  async createPaymentOrder(input: {
    amount: number;
    currency: 'INR';
    receipt: string;
    notes: Record<string, string>;
  }) {
    // receipt = order number and notes carry our payment id, so retries are traceable (FR-PAY-007).
    const order = await this.call<{ id: string }>('POST', '/orders', {
      amount: input.amount,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    });
    return { providerOrderId: order.id };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    return toProviderPayment(
      await this.call('GET', `/payments/${encodeURIComponent(providerPaymentId)}`),
    );
  }

  verifyClientSignature(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): boolean {
    return signatureMatches(
      hmacHex(this.config.keySecret, `${input.providerOrderId}|${input.providerPaymentId}`),
      input.signature,
    );
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    const given = headers['x-razorpay-signature'];
    return this.config.webhookSecrets.some((secret) =>
      signatureMatches(hmacHex(secret, rawBody), given),
    );
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): NormalizedEvent {
    return parseRazorpayStyle(rawBody, headers['x-razorpay-event-id']);
  }

  async refund(input: {
    providerPaymentId: string;
    amount: number;
    refundId: string;
  }): Promise<ProviderRefund> {
    return toProviderRefund(
      await this.call('POST', `/payments/${encodeURIComponent(input.providerPaymentId)}/refund`, {
        amount: input.amount,
        receipt: input.refundId,
        notes: { refundId: input.refundId },
      }),
    );
  }

  async getRefund(providerRefundId: string): Promise<ProviderRefund> {
    return toProviderRefund(
      await this.call('GET', `/refunds/${encodeURIComponent(providerRefundId)}`),
    );
  }
}
