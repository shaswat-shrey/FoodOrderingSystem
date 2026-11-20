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
const INDIRANAGAR = { lat: 12.9719, lng: 77.6412 };
type Dish = {
  item: { name: string; dietaryMarker: string; priceAmount: number; available: boolean };
  branch: { restaurantName: string };
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

const search = (q: string, extra: Record<string, string | number> = {}) =>
  browser(ctx).get('/search', { q, ...KORAMANGALA, ...extra });

suite('search (API-SRCH-001/002, FR-SRCH-001…004, 007, 008)', () => {
  it('finds restaurants by name and cuisine, and dishes by name', async () => {
    const res = await search('biryani');
    expect(res.status).toBe(200);
    expect(
      res.body.data.restaurants.map((r: { restaurantName: string }) => r.restaurantName),
    ).toContain('Saffron Handi Biryani');
    const dishes = res.body.data.dishes as Dish[];
    expect(dishes.length).toBeGreaterThan(1);
    expect(dishes.every((d) => /biryani/i.test(d.item.name))).toBe(true);
    expect(res.body.data.cuisines.map((c: { slug: string }) => c.slug)).toContain('biryani');
  });

  it('matches word prefixes and tolerates typos (FR-SRCH-003)', async () => {
    expect((await search('panee')).body.data.dishes.length).toBeGreaterThan(0);
    const typo = (await search('biriyani')).body.data.dishes as Dish[];
    expect(typo.some((d) => /biryani/i.test(d.item.name))).toBe(true);
  });

  it('only returns what delivers here', async () => {
    const east = (await browser(ctx).get('/search', { q: 'biryani', ...INDIRANAGAR })).body.data;
    expect(east.restaurants.map((r: { branchName: string }) => r.branchName)).toEqual([
      'Indiranagar',
    ]);
    const outside = await browser(ctx).get('/search', { q: 'biryani', lat: 12.925, lng: 77.5838 });
    expect(outside.body.error.code).toBe('LOCATION_NOT_SERVICEABLE');
  });

  it('applies veg-only, type and price filters', async () => {
    const veg = (await search('biryani', { vegOnly: 'true', type: 'dish' })).body.data;
    expect(veg.restaurants).toEqual([]);
    expect(veg.dishes.every((d: Dish) => d.item.dietaryMarker === 'VEG')).toBe(true);
    const cheap = (await search('biryani', { maxPrice: 35_000 })).body.data.dishes as Dish[];
    expect(cheap.every((d) => d.item.priceAmount <= 35_000)).toBe(true);
    expect((await search('b')).status).toBe(400); // 2–100 characters
    expect((await search('biryani', { type: 'drinks' })).status).toBe(400);
  });

  it('pages dish results', async () => {
    const first = await search('paneer', { limit: 1, type: 'dish' });
    const cursor = first.body.meta.pagination.nextCursor as string;
    expect(cursor).toBeTruthy();
    const second = await search('paneer', { limit: 1, type: 'dish', cursor });
    expect(second.body.data.dishes[0].item.name).not.toBe(first.body.data.dishes[0].item.name);
    expect((await search('pizza', { limit: 1, type: 'dish', cursor })).status).toBe(400);
  });

  it('suggests up to 8 completions', async () => {
    const res = await browser(ctx).get('/search/suggestions', { q: 'bir', ...KORAMANGALA });
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.length).toBeLessThanOrEqual(8);
    expect(res.body.data.map((s: { type: string }) => s.type)).toEqual(
      expect.arrayContaining(['restaurant', 'dish']),
    );
    expect((await browser(ctx).get('/search/trending', KORAMANGALA)).body.data).toEqual([]);
  });
});

suite('search history (API-SRCH-004…006, FR-SRCH-005)', () => {
  it('keeps the last distinct queries for signed-in customers and lets them clear it', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    for (const q of ['biryani', 'dosa', 'Biryani!']) await b.get('/search', { q, ...KORAMANGALA });
    const history = (await b.get('/me/search-history')).body.data as {
      id: string;
      query: string;
    }[];
    expect(history.map((h) => h.query)).toEqual(['Biryani!', 'dosa']); // newest first, de-duplicated
    await b.delete(`/me/search-history/${history[1]!.id}`);
    expect((await b.get('/me/search-history')).body.data).toHaveLength(1);
    await b.delete('/me/search-history');
    expect((await b.get('/me/search-history')).body.data).toEqual([]);
    expect((await browser(ctx).get('/me/search-history')).status).toBe(401);
  });
});

suite('favourites (API-FAV-001…006, FR-FAV-001…003)', () => {
  it('adds and removes restaurants idempotently, with serviceability and isFavorite elsewhere', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const restaurant = await ctx.prisma.restaurant.findFirstOrThrow({
      where: { brandName: 'Saffron Handi Biryani' },
    });
    expect((await b.put(`/me/favorites/restaurants/${restaurant.id}`)).status).toBe(200);
    expect((await b.put(`/me/favorites/restaurants/${restaurant.id}`)).status).toBe(200);
    const list = (await b.get('/me/favorites/restaurants', KORAMANGALA)).body.data;
    expect(list).toEqual([
      expect.objectContaining({ restaurantId: restaurant.id, serviceable: true }),
    ]);
    const far = (await b.get('/me/favorites/restaurants', { lat: 12.925, lng: 77.5838 })).body.data;
    expect(far[0]).toMatchObject({
      serviceable: false,
      card: expect.objectContaining({ restaurantName: 'Saffron Handi Biryani' }),
    });

    const listing = (await b.get('/discovery/restaurants', KORAMANGALA)).body.data;
    expect(
      listing.find((c: { restaurantId: string }) => c.restaurantId === restaurant.id).isFavorite,
    ).toBe(true);

    await b.delete(`/me/favorites/restaurants/${restaurant.id}`);
    expect((await b.delete(`/me/favorites/restaurants/${restaurant.id}`)).status).toBe(200);
    expect((await b.get('/me/favorites/restaurants')).body.data).toEqual([]);
    expect(
      (await b.put('/me/favorites/restaurants/01900000-0000-7000-8000-000000000000')).status,
    ).toBe(404);
  });

  it('lists favourite dishes with availability where the customer is', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const dish = await ctx.prisma.foodItem.findFirstOrThrow({
      where: { name: 'Chicken Dum Biryani' },
    });
    await b.put(`/me/favorites/items/${dish.id}`);
    const here = (await b.get('/me/favorites/items', KORAMANGALA)).body.data;
    expect(here[0]).toMatchObject({
      itemId: dish.id,
      serviceable: true,
      item: { available: true },
    });
    const unknown = (await b.get('/me/favorites/items')).body.data;
    expect(unknown[0]).toMatchObject({ serviceable: false, item: null });
    await b.delete(`/me/favorites/items/${dish.id}`);
    expect((await b.get('/me/favorites/items')).body.data).toEqual([]);
  });
});
