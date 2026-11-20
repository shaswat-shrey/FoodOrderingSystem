import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import { UnavailableGeocoder } from '../src/modules/geo';
import {
  branchId,
  browser,
  createTestContext,
  integrationEnabled,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;

/** Today at hh:mm in Bengaluru, so opening-hours rules are deterministic. */
function todayAt(hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const today = localParts(new Date(), 'Asia/Kolkata');
  return zonedInstant(today.year, today.month, today.day, h! * 60 + m!, 'Asia/Kolkata');
}

const KORAMANGALA = { lat: 12.9352, lng: 77.6245 }; // blr-south
const INDIRANAGAR = { lat: 12.9719, lng: 77.6412 }; // blr-east
const JAYANAGAR = { lat: 12.925, lng: 77.5838 }; // outside every zone

beforeAll(async () => {
  if (integrationEnabled) ctx = await createTestContext();
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(() => {
  if (integrationEnabled) ctx.clock.set(todayAt('13:00'));
});

suite('geocoding (API-GEO-001…003, 005; FR-LOC-002/003, FR-ADDR-006)', () => {
  it('suggests pilot-city places, nearest first when a bias point is given', async () => {
    const res = await browser(ctx).get('/geo/autocomplete', {
      q: 'layout',
      lat: 12.912,
      lng: 77.645,
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      title: 'HSR Layout Sector 1',
      placeId: 'mock:hsr-layout-sector-1',
    });
    expect((await browser(ctx).get('/geo/autocomplete', { q: 'ko' })).status).toBe(400); // min 3 chars
  });

  it('resolves a place and reverse-geocodes a pin, echoing the exact pin', async () => {
    const place = await browser(ctx).get('/geo/places/mock:indiranagar-100ft');
    expect(place.body.data).toMatchObject({
      area: 'Indiranagar',
      pincode: '560038',
      city: 'Bengaluru',
    });
    const pin = { lat: 12.93531, lng: 77.62467 };
    const rev = await browser(ctx).get('/geo/reverse', pin);
    expect(rev.body.data).toMatchObject({
      degraded: false,
      address: { area: 'Koramangala', ...pin },
    });
    expect(
      await ctx.prisma.geocodeCache.count({
        where: { key: { startsWith: 'rev:mock:12.9353:77.6247' } },
      }),
    ).toBe(1);
  });

  it('rejects pins outside India (FR-ADDR-006)', async () => {
    const res = await browser(ctx).get('/geo/reverse', { lat: 51.5, lng: -0.12 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ADDRESS_INVALID');
  });

  it('warns when the typed address is far from the pin', async () => {
    const res = await browser(ctx).post('/geo/geocode', {
      area: 'Indiranagar',
      city: 'Bengaluru',
      pin: KORAMANGALA,
    });
    expect(res.body.data).toMatchObject({ result: { area: 'Indiranagar' }, pinWarning: true });
    expect(res.body.data.distanceFromPinM).toBeGreaterThan(3000);
  });
});

suite('degraded geocoding (FR-LOC-002/003)', () => {
  let down: TestContext;
  beforeAll(async () => {
    if (integrationEnabled) down = await createTestContext({ geocoder: new UnavailableGeocoder() });
  });
  afterAll(async () => {
    if (integrationEnabled) await down.close();
  });

  it('reports GEO_PROVIDER_UNAVAILABLE for search, and a degraded reverse result', async () => {
    const search = await browser(down).get('/geo/autocomplete', { q: 'koramangala' });
    expect(search.status).toBe(502);
    expect(search.body.error).toMatchObject({ code: 'GEO_PROVIDER_UNAVAILABLE', retryable: true });
    const rev = await browser(down).get('/geo/reverse', { lat: 12.9101, lng: 77.6301 });
    expect(rev.status).toBe(200);
    expect(rev.body.data).toEqual({ address: null, degraded: true });
  });
});

suite('serviceability (API-GEO-004, FR-LOC-006, BR-GEO-001/002)', () => {
  it('knows the zone, and says OUTSIDE_ZONE where there is none', async () => {
    const inZone = await browser(ctx).get('/geo/serviceability', KORAMANGALA);
    expect(inZone.body.data).toMatchObject({
      serviceable: true,
      zone: { name: expect.stringMatching(/South/) },
    });
    const outside = await browser(ctx).get('/geo/serviceability', JAYANAGAR);
    expect(outside.body.data).toMatchObject({
      serviceable: false,
      reason: 'OUTSIDE_ZONE',
      zone: null,
    });
  });

  it('checks a branch: same zone, radius, status, with delivery numbers', async () => {
    const id = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
    const res = await browser(ctx).get('/geo/serviceability', { ...KORAMANGALA, branchId: id });
    expect(res.body.data).toMatchObject({
      serviceable: true,
      reason: null,
      branch: {
        distanceKm: expect.any(Number),
        deliveryFeeAmount: 1900, // < 2 km road distance
        minOrderAmount: expect.any(Number),
        platformFeeAmount: 500,
        eta: { minMinutes: expect.any(Number), maxMinutes: expect.any(Number) },
      },
    });
    // The same brand's Koramangala branch does not deliver to the other zone.
    const other = await browser(ctx).get('/geo/serviceability', { ...INDIRANAGAR, branchId: id });
    expect(other.body.data).toMatchObject({ serviceable: false, reason: 'OUTSIDE_ZONE' });
  });

  it('reports BRANCH_CLOSED outside hours and BRANCH_PAUSED while paused', async () => {
    const id = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
    ctx.clock.set(todayAt('09:00')); // opens 11:30
    let res = await browser(ctx).get('/geo/serviceability', { ...KORAMANGALA, branchId: id });
    expect(res.body.data).toMatchObject({ serviceable: false, reason: 'BRANCH_CLOSED' });

    ctx.clock.set(todayAt('13:00'));
    await ctx.prisma.branch.update({ where: { id }, data: { pausedUntil: todayAt('13:30') } });
    try {
      res = await browser(ctx).get('/geo/serviceability', { ...KORAMANGALA, branchId: id });
      expect(res.body.data).toMatchObject({ serviceable: false, reason: 'BRANCH_PAUSED' });
    } finally {
      await ctx.prisma.branch.update({ where: { id }, data: { pausedUntil: null } });
    }
  });

  it('caps the radius at the zone maximum and reports OUTSIDE_RADIUS', async () => {
    const id = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
    const zone = await ctx.prisma.branch.findUniqueOrThrow({
      where: { id },
      select: { zoneId: true },
    });
    await ctx.prisma.zone.update({
      where: { id: zone.zoneId },
      data: { maxDeliveryRadiusM: 1000 },
    });
    try {
      const hsr = { lat: 12.9121, lng: 77.6446 }; // ~3.4 km away, inside the zone
      const res = await browser(ctx).get('/geo/serviceability', { ...hsr, branchId: id });
      expect(res.body.data).toMatchObject({ serviceable: false, reason: 'OUTSIDE_RADIUS' });
    } finally {
      await ctx.prisma.zone.update({
        where: { id: zone.zoneId },
        data: { maxDeliveryRadiusM: 7000 },
      });
    }
  });

  it('returns 404 for unknown branches', async () => {
    const res = await browser(ctx).get('/geo/serviceability', {
      ...KORAMANGALA,
      branchId: '01900000-0000-7000-8000-000000000000',
    });
    expect(res.status).toBe(404);
  });
});
