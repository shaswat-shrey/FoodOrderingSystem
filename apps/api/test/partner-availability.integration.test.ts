import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  createTestContext,
  integrationEnabled,
  parkActiveDeliveries,
  PARTNERS,
  signInAs,
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
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
  await parkActiveDeliveries(ctx);
});

const KORAMANGALA = { lat: 12.9352, lng: 77.6245 };
const key = () => ({ 'Idempotency-Key': uuidv7() });
const fix = (over: Record<string, unknown> = {}) => ({
  ...KORAMANGALA,
  accuracyM: 12,
  recordedAt: ctx.clock.now().toISOString(),
  ...over,
});

suite('partner availability (API-DP-014…020, FR-DP-010…015, BR-DEL-006, 010)', () => {
  it('goes online only with a fresh, precise fix inside a zone, and appears to dispatch', async () => {
    const r = await signInAs(ctx, PARTNERS[0], 'DELIVERY');
    const b = r.browser;
    const stale = await b.post(
      '/partner/me/online',
      fix({ recordedAt: new Date(ctx.clock.now().getTime() - 120_000).toISOString() }),
      key(),
    );
    expect(stale.body.error).toMatchObject({
      code: 'PARTNER_CANNOT_GO_ONLINE',
      details: [expect.objectContaining({ code: 'LOCATION_STALE' })],
    });
    expect(
      (await b.post('/partner/me/online', fix({ accuracyM: 400 }), key())).body.error.details[0]
        .code,
    ).toBe('LOCATION_INACCURATE');
    expect(
      (await b.post('/partner/me/online', fix({ lat: 12.925, lng: 77.5838 }), key())).body.error
        .details[0].code,
    ).toBe('OUTSIDE_ZONE');

    const ok = await b.post('/partner/me/online', fix(), key());
    expect(ok.body.data).toMatchObject({ state: 'ONLINE_IDLE', blockers: [] });
    const partner = await ctx.prisma.deliveryPartner.findFirstOrThrow({
      where: { user: { phone: PARTNERS[0] } },
    });
    expect(partner.availabilityState).toBe('ONLINE_IDLE');
    const zone = await ctx.container.serviceability.zoneAt(KORAMANGALA);
    expect(
      (await ctx.container.presence.near(zone!.id, KORAMANGALA, 1_000)).map((x) => x.partnerId),
    ).toContain(partner.id);
    expect(
      await ctx.prisma.partnerOnlineSession.count({
        where: { partnerId: partner.id, endedAt: null },
      }),
    ).toBe(1);

    // Moving updates the live position.
    ctx.clock.advance(30_000);
    const moved = { lat: 12.9361, lng: 77.6262 };
    expect(
      (await b.post('/partner/me/locations', { points: [fix(moved)] })).body.data,
    ).toMatchObject({ accepted: 1, state: 'ONLINE_IDLE' });
    expect(await ctx.container.presence.get(partner.id)).toMatchObject({
      lat: moved.lat,
      lng: moved.lng,
    });

    expect((await b.post('/partner/me/offline', {}, key())).body.data.state).toBe('OFFLINE');
    expect(await ctx.container.presence.near(zone!.id, KORAMANGALA, 1_000)).toEqual([]);
    expect(
      await ctx.prisma.partnerOnlineSession.count({
        where: { partnerId: partner.id, endedAt: null },
      }),
    ).toBe(0);
  });

  it('goes offline automatically when the location stops (BR-DEL-006) and resumes after a break', async () => {
    const a = await signInAs(ctx, PARTNERS[1], 'DELIVERY');
    const c = await signInAs(ctx, PARTNERS[2], 'DELIVERY');
    await a.browser.post('/partner/me/online', fix(), key());
    await c.browser.post('/partner/me/online', fix(), key());
    expect((await c.browser.post('/partner/me/pause', { minutes: 15 })).body.data.state).toBe(
      'PAUSED',
    );
    ctx.clock.advance(6 * 60_000);
    expect(await ctx.container.partnerAvailability.sweep()).toEqual({ offline: 1, resumed: 0 });
    ctx.clock.advance(10 * 60_000);
    expect(await ctx.container.partnerAvailability.sweep()).toMatchObject({ resumed: 1 });
    const pa = await ctx.prisma.deliveryPartner.findFirstOrThrow({
      where: { user: { phone: PARTNERS[1] } },
    });
    expect(
      await ctx.prisma.partnerOnlineSession.findFirst({
        where: { partnerId: pa.id },
        orderBy: { startedAt: 'desc' },
      }),
    ).toMatchObject({ endReason: 'AUTO_INACTIVE' });
  });

  it('keeps partners holding too much cash offline (BR-DEL-010) and shows today’s dashboard', async () => {
    const r = await signInAs(ctx, PARTNERS[3], 'DELIVERY');
    const p = await ctx.prisma.deliveryPartner.findFirstOrThrow({
      where: { user: { phone: PARTNERS[3] } },
    });
    const ref = uuidv7();
    await ctx.prisma.$transaction((tx) =>
      ctx.container.ledger.post(tx, {
        type: 'COD_COLLECTION',
        referenceType: 'test',
        referenceId: ref,
        description: 'test cash',
        entries: [
          { ownerType: 'PARTNER', ownerId: p.id, type: 'PARTNER_CASH_IN_HAND', amount: 300_000 },
          { ownerType: 'PLATFORM', ownerId: null, type: 'CASH_CLEARING', amount: -300_000 },
        ],
      }),
    );
    try {
      const refused = await r.browser.post('/partner/me/online', fix(), key());
      expect(refused.body.error.details.map((d: { code: string }) => d.code)).toEqual(['CASH_CAP']);
      const dash = (await r.browser.get('/partner/me/dashboard')).body.data;
      expect(dash).toMatchObject({
        deliveries: expect.any(Number),
        availability: { state: 'OFFLINE', cashInHand: 300_000, cashCap: 300_000 },
      });
    } finally {
      await ctx.prisma.$transaction((tx) =>
        ctx.container.ledger.post(tx, {
          type: 'CASH_DEPOSIT',
          referenceType: 'test',
          referenceId: ref,
          description: 'undo test cash',
          entries: [
            { ownerType: 'PARTNER', ownerId: p.id, type: 'PARTNER_CASH_IN_HAND', amount: -300_000 },
            { ownerType: 'PLATFORM', ownerId: null, type: 'CASH_CLEARING', amount: 300_000 },
          ],
        }),
      );
    }
  });
});
