import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOwnedRestaurant,
  createTestContext,
  integrationEnabled,
  SAFFRON_STAFF,
  signInAs,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
const batches: string[] = [];

beforeAll(async () => {
  if (integrationEnabled) ctx = await createTestContext();
});
afterAll(async () => {
  if (!integrationEnabled) return;
  await ctx.prisma.restaurantSettlement.updateMany({
    where: { payout: { batchId: { in: batches } } },
    data: { payoutId: null },
  });
  await ctx.prisma.payout.deleteMany({ where: { batchId: { in: batches } } });
  await ctx.prisma.payoutBatch.deleteMany({ where: { id: { in: batches } } });
  await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
});

/** A paid restaurant payout for a unique week (batches are unique per type and start). */
async function payout(restaurantId: string, weeksAgo: number, status: 'PAID' | 'FAILED') {
  const start = new Date(Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 1e6) * 60_000);
  start.setUTCDate(start.getUTCDate() - weeksAgo * 7);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  const batch = await ctx.prisma.payoutBatch.create({
    data: { type: 'RESTAURANT', periodStart: start, periodEnd: end, status: 'PAID' },
  });
  batches.push(batch.id);
  const p = await ctx.prisma.payout.create({
    data: {
      batchId: batch.id,
      payeeType: 'RESTAURANT',
      restaurantId,
      amount: 125_000n,
      status,
      utr: status === 'PAID' ? 'UTR0001' : null,
      failureReason: status === 'FAILED' ? 'Account closed' : null,
      paidAt: status === 'PAID' ? end : null,
      createdAt: new Date(Date.now() - weeksAgo * 60_000),
    },
  });
  await ctx.prisma.restaurantSettlement.create({
    data: {
      restaurantId,
      periodStart: start,
      periodEnd: end,
      grossAmount: 150_000n,
      commissionAmount: 22_500n,
      discountsAmount: 0n,
      taxesAmount: 2_500n,
      adjustmentsAmount: 0n,
      netAmount: 125_000n,
      status: 'PAID',
      payoutId: p.id,
    },
  });
  return p;
}

suite('restaurant payouts (FR-RFIN-002)', () => {
  it('lists the restaurant’s payouts newest first, with the settlement and paging', async () => {
    const owner = await createOwnedRestaurant(ctx);
    const older = await payout(owner.restaurantId, 2, 'FAILED');
    const newer = await payout(owner.restaurantId, 1, 'PAID');
    const b = owner.browser;
    const all = await b.get(`/merchant/restaurants/${owner.restaurantId}/payouts`);
    expect(all.status).toBe(200);
    expect(all.body.data.map((p: { id: string }) => p.id)).toEqual([newer.id, older.id]);
    expect(all.body.data[0]).toMatchObject({
      amount: 125_000,
      status: 'PAID',
      utr: 'UTR0001',
      settlement: { gross: 150_000, commission: 22_500, net: 125_000 },
    });
    expect(all.body.data[1]).toMatchObject({ status: 'FAILED', failureReason: 'Account closed' });

    const first = await b.get(`/merchant/restaurants/${owner.restaurantId}/payouts?limit=1`);
    expect(first.body.data).toHaveLength(1);
    const cursor = first.body.meta.pagination.nextCursor as string;
    expect(cursor).toBeTruthy();
    const second = await b.get(
      `/merchant/restaurants/${owner.restaurantId}/payouts?limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(second.body.data.map((p: { id: string }) => p.id)).toEqual([older.id]);
  });

  it('needs finance access and membership of that restaurant', async () => {
    const owner = await createOwnedRestaurant(ctx);
    const saffron = await ctx.prisma.restaurant.findFirstOrThrow({
      where: { brandName: 'Saffron Handi Biryani' },
    });
    // Managers have no finance permission.
    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    expect((await manager.browser.get(`/merchant/restaurants/${saffron.id}/payouts`)).status).toBe(
      403,
    );
    // Another restaurant's owner can't see it at all.
    expect((await owner.browser.get(`/merchant/restaurants/${saffron.id}/payouts`)).status).toBe(
      404,
    );
  });
});
