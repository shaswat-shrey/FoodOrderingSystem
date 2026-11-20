import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env';
import { createHealthServer } from './health-server';
import {
  ANONYMIZE_DUE_USERS_JOB,
  EXPIRE_IDLE_CARTS_JOB,
  VERIFY_LEDGER_JOB,
  buildRegistrations,
  createMessageSink,
  SCHEDULES,
} from './processors';
import type { AccountAnonymizer, CartExpiry } from '@fos/api/jobs';
import { createLogger } from '@fos/api/platform';
import type { Message, MessageSink } from '@fos/api/notifications';

let close: (() => void) | undefined;
const baseEnv = {
  REDIS_CORE_URL: 'redis://localhost:6379',
  DATABASE_URL: 'postgresql://fos:pw@localhost:5432/fos',
  AUTH_HMAC_SECRET: 'h'.repeat(32),
};
const silent = createLogger({ level: 'silent', service: 'worker' });
const fakeAnonymizer = (count: number) =>
  ({ run: async () => count }) as unknown as AccountAnonymizer;
afterEach(() => close?.());

async function serve(redisUp: boolean) {
  const server = createHealthServer({
    critical: {
      redisCore: async () => {
        if (!redisUp) throw new Error('ECONNREFUSED');
      },
    },
    degradable: {},
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  close = () => server.close();
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

const fakePayments = {
  processWebhook: async () => {},
  processPendingWebhooks: async () => 0,
  resolveStuck: async () => 0,
};
const fakeRefunds = { submit: async () => {}, sweep: async () => ({ submitted: 0, polled: 0 }) };
const fakeOrderJobs = { run: async () => {}, sweep: async () => 0 };
const fakeOutbox = { checkStale: async () => 0 };

describe('worker', () => {
  it('validates its environment', () => {
    expect(loadWorkerEnv(baseEnv).WORKER_HEALTH_PORT).toBe(4001);
    expect(() => loadWorkerEnv({})).toThrow(/REDIS_CORE_URL/);
    expect(() => loadWorkerEnv({ REDIS_CORE_URL: 'redis://x:1' })).toThrow(/DATABASE_URL/);
  });

  it('reports ready only when Redis is reachable', async () => {
    const ok = await fetch(`${await serve(true)}/health/ready`);
    expect(ok.status).toBe(200);
    close?.();
    const down = await fetch(`${await serve(false)}/health/ready`);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({
      status: 'unavailable',
      checks: { redisCore: { error: 'unreachable' } },
    });
  });

  it('delivers queued account messages through the configured sink', async () => {
    const delivered: Message[] = [];
    const sink: MessageSink = { deliver: async (m) => void delivered.push(m) };
    const notifications = buildRegistrations({
      sink,
      anonymizer: fakeAnonymizer(0),
      cartExpiry: { run: async () => 0 } as unknown as CartExpiry,
      ledger: { verify: async () => [] },
      payments: fakePayments,
      refunds: fakeRefunds,
      orderJobs: fakeOrderJobs,
      outbox: fakeOutbox,
      deliverer: { deliver: async () => {} },
      files: { cleanupOrphans: async () => 0 },
      logger: silent,
    }).find((r) => r.queue === 'notifications');
    const message: Message = {
      channel: 'SMS',
      to: '+919000000101',
      template: 'OTP',
      vars: { code: '123456', purpose: 'LOGIN', minutes: 5 },
    };
    await notifications!.processor({ name: 'send-message', data: message } as never);
    expect(delivered).toEqual([message]);
  });

  it('requires S3 storage settings in production', () => {
    expect(() =>
      loadWorkerEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        RAZORPAY_KEY_ID: 'k',
        RAZORPAY_KEY_SECRET: 's',
        RAZORPAY_WEBHOOK_SECRETS: 'w',
      }),
    ).toThrow(/STORAGE_ACCESS_KEY/);
  });

  it('refuses dev sinks in production', () => {
    const env = loadWorkerEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      RAZORPAY_KEY_ID: 'k',
      RAZORPAY_KEY_SECRET: 's',
      RAZORPAY_WEBHOOK_SECRETS: 'w',
      STORAGE_ACCESS_KEY: 'a',
      STORAGE_SECRET_KEY: 's',
      API_PUBLIC_URL: 'https://api.example.com',
    });
    expect(() =>
      createMessageSink(env, createLogger({ level: 'silent', service: 'worker' })),
    ).toThrow(/provider/);
  });

  it('JOB-USER-001: runs the account anonymiser hourly on the maintenance queue', async () => {
    let runs = 0;
    const anonymizer = { run: async () => (runs += 1) } as unknown as AccountAnonymizer;
    const maintenance = buildRegistrations({
      sink: { deliver: async () => {} },
      anonymizer,
      cartExpiry: { run: async () => 0 } as unknown as CartExpiry,
      ledger: { verify: async () => [] },
      payments: fakePayments,
      refunds: fakeRefunds,
      orderJobs: fakeOrderJobs,
      outbox: fakeOutbox,
      deliverer: { deliver: async () => {} },
      files: { cleanupOrphans: async () => 0 },
      logger: silent,
    }).find((r) => r.queue === 'maintenance');
    await maintenance!.processor({ name: ANONYMIZE_DUE_USERS_JOB } as never);
    expect(runs).toBe(1);
    await expect(maintenance!.processor({ name: 'no-such-job' } as never)).rejects.toThrow(
      /Unknown/,
    );
    expect(SCHEDULES).toContainEqual({
      queue: 'maintenance',
      id: ANONYMIZE_DUE_USERS_JOB,
      everyMs: 3_600_000,
    });
  });

  it('JOB-CART-001: expires idle carts hourly', async () => {
    let runs = 0;
    const maintenance = buildRegistrations({
      sink: { deliver: async () => {} },
      anonymizer: fakeAnonymizer(0),
      cartExpiry: { run: async () => (runs += 1) } as unknown as CartExpiry,
      ledger: { verify: async () => [] },
      payments: fakePayments,
      refunds: fakeRefunds,
      orderJobs: fakeOrderJobs,
      outbox: fakeOutbox,
      deliverer: { deliver: async () => {} },
      files: { cleanupOrphans: async () => 0 },
      logger: silent,
    }).find((r) => r.queue === 'maintenance');
    await maintenance!.processor({ name: EXPIRE_IDLE_CARTS_JOB } as never);
    expect(runs).toBe(1);
    expect(SCHEDULES).toContainEqual({
      queue: 'maintenance',
      id: EXPIRE_IDLE_CARTS_JOB,
      everyMs: 3_600_000,
    });
  });

  it('JOB-LEDGER-001: fails loudly when a balance does not match its entries', async () => {
    const mismatch = { accountId: 'a', type: 'CUSTOMER_WALLET', stored: 1n, computed: 0n };
    const maintenance = buildRegistrations({
      sink: { deliver: async () => {} },
      anonymizer: fakeAnonymizer(0),
      cartExpiry: { run: async () => 0 } as unknown as CartExpiry,
      ledger: { verify: async () => [mismatch] },
      payments: fakePayments,
      refunds: fakeRefunds,
      orderJobs: fakeOrderJobs,
      outbox: fakeOutbox,
      deliverer: { deliver: async () => {} },
      files: { cleanupOrphans: async () => 0 },
      logger: silent,
    }).find((r) => r.queue === 'maintenance');
    await expect(maintenance!.processor({ name: VERIFY_LEDGER_JOB } as never)).rejects.toThrow(
      /integrity/,
    );
    expect(SCHEDULES).toContainEqual({
      queue: 'maintenance',
      id: VERIFY_LEDGER_JOB,
      everyMs: 86_400_000,
    });
  });

  it('routes order timer jobs by name and runs the timer sweeper', async () => {
    const calls: string[] = [];
    const orders = buildRegistrations({
      sink: { deliver: async () => {} },
      anonymizer: {} as AccountAnonymizer,
      cartExpiry: { run: async () => 0, expireSessions: async () => 0 } as unknown as CartExpiry,
      ledger: { verify: async () => [] },
      payments: fakePayments,
      refunds: fakeRefunds,
      orderJobs: {
        run: async (name, orderId) => void calls.push(`${name}/${orderId}`),
        sweep: async () => (calls.push('sweep'), 0),
      },
      outbox: fakeOutbox,
      deliverer: { deliver: async () => {} },
      files: { cleanupOrphans: async () => 0 },
      logger: silent,
    }).find((r) => r.queue === 'orders')!;
    await orders.processor({ name: 'payment-ttl', data: { orderId: 'o1' } } as never);
    await orders.processor({ name: 'sweep-order-timers', data: {} } as never);
    expect(calls).toEqual(['payment-ttl/o1', 'sweep']);
    expect(SCHEDULES).toContainEqual({
      queue: 'orders',
      id: 'sweep-order-timers',
      everyMs: 5 * 60 * 1000,
    });
  });
});
