import { z } from 'zod';
import { MockPaymentProvider } from './mock-provider';
import type { PaymentProvider } from './provider';
import { RazorpayProvider } from './razorpay-provider';

/** Payment settings shared by the API and the worker (FR-PAY-001, FR-PAY-014). */
export const paymentEnvFields = {
  /** `mock` = in-memory provider for development and tests; refused in production. */
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).optional(),
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  /** Comma-separated; during rotation both old and new secrets verify (FR-PAY-014). */
  RAZORPAY_WEBHOOK_SECRETS: z.string().min(1).optional(),
  MOCK_PAYMENT_KEY_SECRET: z.string().min(8).default('mock-key-secret-dev-only'),
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(8).default('mock-webhook-secret-dev-only'),
};

/** The parsed shape of the fields above (only the type is needed). */
export const paymentEnvSchema = z.object(paymentEnvFields);
type PaymentEnv = { NODE_ENV: string } & z.output<typeof paymentEnvSchema>;

export const paymentProviderOf = (env: PaymentEnv) =>
  env.PAYMENT_PROVIDER ?? (env.NODE_ENV === 'production' ? 'razorpay' : 'mock');

/** Production problems, as [variable, message] pairs (messages never contain values). */
export function paymentEnvProblems(env: PaymentEnv): [string, string][] {
  if (env.NODE_ENV !== 'production') return [];
  if (paymentProviderOf(env) === 'mock')
    return [['PAYMENT_PROVIDER', 'The mock payment provider cannot be used in production']];
  return (['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRETS'] as const)
    .filter((k) => !env[k])
    .map((k) => [k, 'Required for Razorpay in production']);
}

export function createPaymentProvider(env: PaymentEnv): PaymentProvider {
  if (paymentProviderOf(env) === 'razorpay') {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRETS) {
      throw new Error(
        'Razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRETS',
      );
    }
    return new RazorpayProvider({
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
      webhookSecrets: env.RAZORPAY_WEBHOOK_SECRETS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return new MockPaymentProvider(env.MOCK_PAYMENT_KEY_SECRET, env.MOCK_PAYMENT_WEBHOOK_SECRET);
}
