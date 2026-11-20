import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { authenticate } from '../src/modules/auth';
import { createApp } from '../src/platform/http/app';
import { sendOk } from '../src/platform/http/envelope';
import { requireClientApp } from '../src/platform/http/middleware/client-app';
import { idempotent } from '../src/platform/http/middleware/idempotency';
import { createLogger } from '../src/platform/logger';
import {
  branchId,
  createFixtureOrder,
  createTestContext,
  integrationEnabled,
  ORIGINS,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;

beforeAll(async () => {
  if (integrationEnabled) ctx = await createTestContext();
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (integrationEnabled) await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
});

const giveCredit = (
  userId: string,
  amount: number,
  source: 'PROMO' | 'GOODWILL' | 'REFUND',
  expiresAt?: Date | null,
) =>
  ctx.prisma.$transaction((tx) =>
    ctx.container.wallet.credit(tx, {
      userId,
      amount,
      source,
      referenceType: 'test',
      referenceId: uuidv7(),
      description: `${source} credit`,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }),
  );

suite('ledger (ADR-011, FR-PAY-013, FR-RECON-003)', () => {
  it('posts balanced transactions once and keeps balances on the normal side', async () => {
    const { userId } = await signUpCustomer(ctx);
    const ref = uuidv7();
    const post = () =>
      ctx.prisma.$transaction((tx) =>
        ctx.container.ledger.post(tx, {
          type: 'ADJUSTMENT',
          referenceType: 'test',
          referenceId: ref,
          description: 'goodwill',
          entries: [
            {
              ownerType: 'PLATFORM',
              ownerId: null,
              type: 'PLATFORM_REFUND_EXPENSE',
              amount: 5_000,
            },
            { ownerType: 'CUSTOMER', ownerId: userId, type: 'CUSTOMER_WALLET', amount: -5_000 },
          ],
        }),
      );
    expect((await post()).duplicate).toBe(false);
    expect((await post()).duplicate).toBe(true);
    expect(await ctx.container.wallet.available(userId)).toBe(5_000);
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('refuses unbalanced or single-entry transactions', async () => {
    const entries = [
      {
        ownerType: 'PLATFORM' as const,
        ownerId: null,
        type: 'PLATFORM_REFUND_EXPENSE' as const,
        amount: 100,
      },
      {
        ownerType: 'PLATFORM' as const,
        ownerId: null,
        type: 'GATEWAY_CLEARING' as const,
        amount: -99,
      },
    ];
    await expect(
      ctx.prisma.$transaction((tx) =>
        ctx.container.ledger.post(tx, {
          type: 'ADJUSTMENT',
          referenceType: 'test',
          referenceId: uuidv7(),
          description: 'x',
          entries,
        }),
      ),
    ).rejects.toThrow(/sum to zero/);
  });
});

suite('wallet (FR-PAY-012, BR-WALLET-002/003, API-WAL-001/002)', () => {
  it('holds, then debits earliest-expiring credits first, or releases the hold', async () => {
    const { userId, browser: b } = await signUpCustomer(ctx);
    const soon = new Date(Date.now() + 3 * 86_400_000);
    await giveCredit(userId, 10_000, 'REFUND'); // never expires
    await giveCredit(userId, 3_000, 'PROMO', soon);
    const branch = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');

    const paid = await createFixtureOrder(ctx, {
      userId,
      branchId: branch,
      walletAppliedAmount: 4_000,
      payableAmount: 1_000,
    });
    await ctx.prisma.$transaction((tx) =>
      ctx.container.wallet.hold(tx, { userId, orderId: paid.orderId, amount: 4_000 }),
    );
    expect((await b.get('/me/wallet')).body.data).toMatchObject({
      availableAmount: 9_000,
      heldAmount: 4_000,
    });
    await ctx.prisma.$transaction((tx) =>
      ctx.container.wallet.debit(tx, { userId, orderId: paid.orderId, amount: 4_000 }),
    );
    const lots = await ctx.prisma.walletCreditLot.findMany({
      where: { account: { ownerId: userId } },
      orderBy: { amount: 'asc' },
    });
    expect(lots.map((l) => [l.source, l.remaining])).toEqual([
      ['PROMO', 0], // expiring credit used first
      ['REFUND', 9_000],
    ]);

    const failed = await createFixtureOrder(ctx, {
      userId,
      branchId: branch,
      walletAppliedAmount: 2_000,
      payableAmount: 1_000,
    });
    await ctx.prisma.$transaction((tx) =>
      ctx.container.wallet.hold(tx, { userId, orderId: failed.orderId, amount: 2_000 }),
    );
    await ctx.prisma.$transaction((tx) =>
      ctx.container.wallet.release(tx, { userId, orderId: failed.orderId, amount: 2_000 }),
    );
    expect((await b.get('/me/wallet')).body.data).toMatchObject({
      availableAmount: 9_000,
      heldAmount: 0,
    });
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('never goes negative', async () => {
    const { userId } = await signUpCustomer(ctx);
    await giveCredit(userId, 1_000, 'GOODWILL');
    const order = await createFixtureOrder(ctx, {
      userId,
      branchId: await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala'),
    });
    await expect(
      ctx.prisma.$transaction((tx) =>
        ctx.container.wallet.hold(tx, { userId, orderId: order.orderId, amount: 1_001 }),
      ),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_WALLET_BALANCE',
    });
  });

  it('lists wallet movements newest first with paging, and expiring credits', async () => {
    const { userId, browser: b } = await signUpCustomer(ctx);
    await giveCredit(userId, 1_000, 'GOODWILL');
    await giveCredit(userId, 2_000, 'PROMO');
    await giveCredit(userId, 3_000, 'REFUND');
    const first = await b.get('/me/wallet/transactions', { limit: 2 });
    expect(first.body.data.map((t: { amount: number }) => t.amount)).toEqual([3_000, 2_000]);
    const second = await b.get('/me/wallet/transactions', {
      limit: 2,
      cursor: first.body.meta.pagination.nextCursor,
    });
    expect(second.body.data.map((t: { amount: number }) => t.amount)).toEqual([1_000]);
    expect(second.body.meta.pagination.nextCursor).toBeNull();
    const summary = (await b.get('/me/wallet')).body.data;
    expect(summary.expiringCredits.map((c: { source: string }) => c.source).sort()).toEqual([
      'GOODWILL',
      'PROMO',
    ]);
  });
});

suite('idempotency keys (FR-ORDER-002, FR-PAY-007)', () => {
  let probeCalls = 0;
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    if (!integrationEnabled) return;
    app = createApp({
      logger: createLogger({ level: 'silent', service: 'api' }),
      corsOrigins: [ORIGINS.CUSTOMER],
      readiness: { critical: {}, degradable: {} },
      routes: (api) => {
        api.post(
          '/probe',
          requireClientApp(),
          authenticate(ctx.container),
          idempotent(ctx.prisma),
          async (req, res) => {
            probeCalls += 1;
            await new Promise((r) => setTimeout(r, 150));
            sendOk(res, { call: probeCalls, echo: req.body }, { status: 201 });
          },
        );
      },
    });
  });

  it('runs once per key, replays the response, and rejects the key for another body', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const send = (key: string | null, body: object) => {
      const r = request(app)
        .post('/api/v1/probe')
        .set('X-Client-App', 'CUSTOMER')
        .set('Authorization', `Bearer ${b.token}`);
      if (key) r.set('Idempotency-Key', key);
      return r.send(body);
    };
    expect((await send(null, { a: 1 })).status).toBe(400);
    const key = uuidv7();
    const before = probeCalls;
    // Concurrent duplicates (double click): one execution, same answer.
    const [x, y] = await Promise.all([send(key, { a: 1, b: 2 }), send(key, { b: 2, a: 1 })]);
    expect(probeCalls - before).toBe(1);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.body.data).toEqual(y.body.data);
    expect(
      [x.headers['idempotent-replayed'], y.headers['idempotent-replayed']].filter(Boolean),
    ).toEqual(['true']);
    const other = await send(key, { a: 2 });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
