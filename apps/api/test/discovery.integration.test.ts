import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  browser,
  createTestContext,
  integrationEnabled,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;

function todayAt(hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const t = localParts(new Date(), 'Asia/Kolkata');
  return zonedInstant(t.year, t.month, t.day, h! * 60 + m!, 'Asia/Kolkata');
}
const KORAMANGALA = { lat: 12.9352, lng: 77.6245 };
type Card = {
  restaurantName: string;
  branchName: string;
  pureVeg: boolean;
  cuisines: string[];
  status: { acceptingOrders: boolean };
  delivery: { distanceKm: number; serviceable: boolean };
};

beforeAll(async () => {
  if (integrationEnabled) ctx = await createTestContext();
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  ctx.clock.set(todayAt('13:00'));
});

const list = async (query: Record<string, string | number> = {}) =>
  browser(ctx).get('/discovery/restaurants', { ...KORAMANGALA, ...query });

suite('restaurant listing (API-DISC-001, FR-DISC-001…004)', () => {
  it('lists serviceable restaurants in the customer’s zone, one branch per brand', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const names = (res.body.data as Card[]).map((c) => c.restaurantName);
    expect(names).toContain('Saffron Handi Biryani');
    expect(names).not.toContain('Lantern Lane Wok'); // other zone
    expect(new Set(names).size).toBe(names.length);
    expect(res.body.data[0]).toMatchObject({
      delivery: { serviceable: true },
      status: { acceptingOrders: true },
    });
  });

  it('says LOCATION_NOT_SERVICEABLE outside every zone', async () => {
    const res = await browser(ctx).get('/discovery/restaurants', { lat: 12.925, lng: 77.5838 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'LOCATION_NOT_SERVICEABLE',
      details: [expect.objectContaining({ code: 'OUTSIDE_ZONE' })],
    });
  });

  it('filters by cuisine and pure veg, and rejects unknown filters', async () => {
    const pizza = (await list({ cuisines: 'pizza' })).body.data as Card[];
    expect(pizza.map((c) => c.restaurantName)).toEqual(['Ember & Crust Pizzeria']);
    const veg = (await list({ pureVeg: 'true' })).body.data as Card[];
    expect(veg.length).toBeGreaterThan(0);
    expect(veg.every((c) => c.pureVeg)).toBe(true);
    expect((await list({ minRating: '3' })).status).toBe(400);
    expect((await list({ spicy: 'yes' })).status).toBe(400);
  });

  it('sorts by distance with closed restaurants trailing', async () => {
    const byDistance = (await list({ sort: 'distance' })).body.data as Card[];
    const distances = byDistance.map((c) => c.delivery.distanceKm);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));

    ctx.clock.set(todayAt('08:00')); // only breakfast places are open
    const early = (await list({ sort: 'distance' })).body.data as Card[];
    const firstClosed = early.findIndex((c) => !c.status.acceptingOrders);
    expect(firstClosed).toBeGreaterThan(0);
    expect(early.slice(firstClosed).every((c) => !c.status.acceptingOrders)).toBe(true);
    expect(
      (await list({ openNow: 'true' })).body.data.every((c: Card) => c.status.acceptingOrders),
    ).toBe(true);
  });

  it('paginates with an opaque cursor and rejects tampered ones', async () => {
    const all = (await list({ sort: 'rating', limit: 50 })).body.data as Card[];
    const first = await list({ sort: 'rating', limit: 2 });
    const cursor = first.body.meta.pagination.nextCursor as string;
    expect(cursor).toBeTruthy();
    const second = await list({ sort: 'rating', limit: 2, cursor });
    const seen = [...first.body.data, ...second.body.data].map((c: Card) => c.restaurantName);
    expect(seen).toEqual(all.slice(0, 4).map((c) => c.restaurantName));
    expect((await list({ sort: 'distance', limit: 2, cursor })).status).toBe(400); // different query
    expect((await list({ limit: 2, cursor: 'garbage' })).status).toBe(400);
    expect((await list({ limit: 51 })).status).toBe(400);
  });
});

suite('home, collections, cuisines and dishes (API-DISC-002…006, 008…011)', () => {
  it('builds home sections and caches them per area', async () => {
    const res = await browser(ctx).get('/discovery/home', KORAMANGALA);
    expect(res.status).toBe(200);
    const keys = res.body.data.sections.map((s: { key: string }) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['featured', 'recommended', 'bestsellers']));
    expect(res.body.data.cuisines.length).toBeGreaterThan(0);
    expect(res.body.data.orderAgain).toEqual([]);
    expect(await ctx.redis.cache.keys('home:v1:*')).toHaveLength(1);
  });

  it('serves curated collections in curator order', async () => {
    const res = await browser(ctx).get('/discovery/collections/featured', KORAMANGALA);
    expect(res.body.data.title).toBe('Featured this week');
    expect(res.body.data.restaurants.map((r: Card) => r.restaurantName)).toEqual(
      expect.arrayContaining(['Saffron Handi Biryani', 'Ember & Crust Pizzeria']),
    );
    expect(
      (await browser(ctx).get('/discovery/collections/top-rated', KORAMANGALA)).body.data
        .restaurants,
    ).toEqual([]);
    expect(
      (await browser(ctx).get('/discovery/collections/no-such-thing', KORAMANGALA)).status,
    ).toBe(404);
  });

  it('lists cuisines here and restaurants per cuisine', async () => {
    const cuisines = (await browser(ctx).get('/discovery/cuisines', KORAMANGALA)).body.data as {
      slug: string;
      restaurantCount: number;
    }[];
    expect(cuisines.find((c) => c.slug === 'biryani')?.restaurantCount).toBe(1);
    const res = await browser(ctx).get('/discovery/cuisines/biryani/restaurants', KORAMANGALA);
    expect(res.body.data.map((c: Card) => c.restaurantName)).toEqual(['Saffron Handi Biryani']);
  });

  it('finds dishes by food category and today’s specials', async () => {
    const biryani = (await browser(ctx).get('/discovery/categories/biryani/items', KORAMANGALA))
      .body.data;
    expect(biryani.length).toBeGreaterThan(0);
    // Matches the dish name or its menu category, so a "Biryani" category may include sides.
    expect(
      biryani.filter((r: { item: { name: string } }) => /biryani/i.test(r.item.name)).length,
    ).toBeGreaterThan(1);
    expect(biryani.some((r: { item: { name: string } }) => /pizza/i.test(r.item.name))).toBe(false);
    const veg = (
      await browser(ctx).get('/discovery/categories/biryani/items', {
        ...KORAMANGALA,
        vegOnly: 'true',
      })
    ).body.data;
    expect(
      veg.every((r: { item: { dietaryMarker: string } }) => r.item.dietaryMarker === 'VEG'),
    ).toBe(true);
    const specials = (await browser(ctx).get('/discovery/items/specials', KORAMANGALA)).body.data;
    expect(specials[0]).toMatchObject({
      item: { available: true },
      branch: { restaurantName: expect.any(String) },
    });
  });

  it('reports facets and banners', async () => {
    const facets = (await browser(ctx).get('/discovery/facets', KORAMANGALA)).body.data;
    expect(facets.total).toBeGreaterThan(0);
    expect(facets.pureVeg).toBeGreaterThan(0);
    expect((await browser(ctx).get('/discovery/banners', KORAMANGALA)).body.data).toEqual([]);
  });

  it('order-again needs a signed-in customer', async () => {
    expect((await browser(ctx).get('/discovery/order-again', KORAMANGALA)).status).toBe(401);
    const { browser: b } = await signUpCustomer(ctx);
    expect((await b.get('/discovery/order-again', KORAMANGALA)).body.data).toEqual([]);
  });
});
