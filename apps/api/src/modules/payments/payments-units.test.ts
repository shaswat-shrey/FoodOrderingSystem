import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockPaymentProvider } from './mock-provider';
import { instrumentOf, parseRazorpayStyle, ProviderError, signatureMatches } from './provider';
import { RazorpayProvider } from './razorpay-provider';
import { canTransition } from './status';

describe('payment status precedence (FR-PAY-009)', () => {
  it.each([
    ['CREATED', 'PENDING', true],
    ['PENDING', 'CAPTURED', true],
    ['AUTHORIZED', 'CAPTURED', true],
    ['CAPTURED', 'AUTHORIZED', false], // late, out-of-order event
    ['CAPTURED', 'FAILED', false], // failures only before capture
    ['PENDING', 'FAILED', true],
    ['FAILED', 'CAPTURED', true], // accounted for, then refunded (BR-PAY-005)
    ['FAILED', 'AUTHORIZED', false],
    ['CAPTURED', 'PARTIALLY_REFUNDED', true],
    ['REFUNDED', 'PARTIALLY_REFUNDED', false],
    ['CAPTURED', 'CAPTURED', false],
  ] as const)('%s → %s: %s', (from, to, ok) => {
    expect(canTransition(from, to)).toBe(ok);
  });
});

const hmac = (secret: string, msg: string | Buffer) =>
  createHmac('sha256', secret).update(msg).digest('hex');

describe('Razorpay adapter (FR-PAY-001, 003, 004, 014)', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fake = (responses: Response[]) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses.shift()!;
    }) as unknown as typeof fetch;

  it('creates orders with basic auth and maps payments', async () => {
    calls.length = 0;
    const rzp = new RazorpayProvider({
      keyId: 'rzp_test_k',
      keySecret: 'sk',
      webhookSecrets: ['w1'],
      fetch: fake([
        reply(200, { id: 'order_1' }),
        reply(200, {
          id: 'pay_1',
          order_id: 'order_1',
          amount: 50_000,
          currency: 'INR',
          status: 'captured',
          method: 'card',
          card: { last4: '4242', network: 'Visa' },
        }),
      ]),
    });
    expect(
      await rzp.createPaymentOrder({
        amount: 50_000,
        currency: 'INR',
        receipt: 'A1',
        notes: { paymentId: 'p' },
      }),
    ).toEqual({ providerOrderId: 'order_1' });
    expect(calls[0]!.url).toBe('https://api.razorpay.com/v1/orders');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('rzp_test_k:sk').toString('base64')}`,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      amount: 50_000,
      currency: 'INR',
      receipt: 'A1',
      notes: { paymentId: 'p' },
    });
    expect(await rzp.getPayment('pay_1')).toMatchObject({
      status: 'CAPTURED',
      amount: 50_000,
      instrumentSummary: 'Visa •• 4242',
    });
  });

  it('turns provider errors into ProviderError', async () => {
    const rzp = new RazorpayProvider({
      keyId: 'k',
      keySecret: 's',
      webhookSecrets: ['w'],
      fetch: fake([reply(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'nope' } })]),
    });
    await expect(rzp.getPayment('x')).rejects.toMatchObject({
      name: 'ProviderError',
      status: 400,
      code: 'BAD_REQUEST_ERROR',
    });
    const offline = new RazorpayProvider({
      keyId: 'k',
      keySecret: 's',
      webhookSecrets: ['w'],
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(offline.getPayment('x')).rejects.toBeInstanceOf(ProviderError);
  });

  it('verifies the checkout signature (order_id|payment_id) and webhook bodies with rotated secrets', () => {
    const rzp = new RazorpayProvider({
      keyId: 'k',
      keySecret: 'key-secret',
      webhookSecrets: ['old', 'new'],
    });
    const signature = hmac('key-secret', 'order_1|pay_1');
    expect(
      rzp.verifyClientSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        signature,
      }),
    ).toBe(true);
    expect(
      rzp.verifyClientSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_2',
        signature,
      }),
    ).toBe(false);
    const body = Buffer.from('{"event":"payment.captured"}');
    expect(rzp.verifyWebhook(body, { 'x-razorpay-signature': hmac('old', body) })).toBe(true);
    expect(rzp.verifyWebhook(body, { 'x-razorpay-signature': hmac('new', body) })).toBe(true);
    expect(rzp.verifyWebhook(body, { 'x-razorpay-signature': hmac('other', body) })).toBe(false);
    expect(
      rzp.verifyWebhook(Buffer.from(`${body} `), { 'x-razorpay-signature': hmac('new', body) }),
    ).toBe(false); // raw bytes matter
  });

  it('compares signatures safely', () => {
    expect(signatureMatches('abcd', 'ABCD')).toBe(true);
    expect(signatureMatches('abcd', 'abc')).toBe(false);
    expect(signatureMatches('abcd', 'not-hex')).toBe(false);
    expect(signatureMatches('abcd', undefined)).toBe(false);
  });
});

describe('webhook normalisation and instruments (FR-PAY-015)', () => {
  it('maps provider events to canonical ones', () => {
    const raw = Buffer.from(
      JSON.stringify({
        event: 'payment.failed',
        created_at: 1_700_000_000,
        payload: {
          payment: {
            entity: {
              id: 'pay_1',
              order_id: 'order_1',
              amount: 100,
              currency: 'INR',
              status: 'failed',
              error_code: 'X',
            },
          },
        },
      }),
    );
    expect(parseRazorpayStyle(raw, 'evt_1')).toMatchObject({
      eventId: 'evt_1',
      type: 'PAYMENT_FAILED',
      payment: { status: 'FAILED', errorCode: 'X' },
    });
    expect(parseRazorpayStyle(Buffer.from('{"event":"subscription.charged"}'), 'e').type).toBe(
      'UNKNOWN',
    );
  });

  it('masks instruments', () => {
    expect(
      instrumentOf({
        id: 'p',
        amount: 1,
        currency: 'INR',
        status: 'captured',
        method: 'upi',
        vpa: 'asha.rao@okicici',
      }),
    ).toBe('UPI • as***@okicici');
    expect(
      instrumentOf({
        id: 'p',
        amount: 1,
        currency: 'INR',
        status: 'captured',
        method: 'netbanking',
        bank: 'HDFC',
      }),
    ).toBe('Netbanking • HDFC');
  });

  it('the mock signs like the real provider', async () => {
    const mock = new MockPaymentProvider('ks-secret', 'wh-secret');
    const { providerOrderId } = await mock.createPaymentOrder({
      amount: 500,
      currency: 'INR',
      receipt: 'r',
      notes: {},
    });
    const paid = mock.pay(providerOrderId, 'success');
    expect(
      mock.verifyClientSignature({
        providerOrderId,
        providerPaymentId: paid.providerPaymentId,
        signature: paid.signature,
      }),
    ).toBe(true);
    expect(mock.verifyWebhook(paid.webhook.body, paid.webhook.headers)).toBe(true);
    expect(mock.parseWebhook(paid.webhook.body, paid.webhook.headers)).toMatchObject({
      type: 'PAYMENT_CAPTURED',
      payment: { amount: 500 },
    });
  });
});
