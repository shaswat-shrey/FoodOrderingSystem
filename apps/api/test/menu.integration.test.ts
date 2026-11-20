import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  branchId,
  browser,
  createTestContext,
  integrationEnabled,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let koramangala: string;
let restaurantId: string;

function todayAt(hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const t = localParts(new Date(), 'Asia/Kolkata');
  return zonedInstant(t.year, t.month, t.day, h! * 60 + m!, 'Asia/Kolkata');
}
const HOME = { lat: 12.9352, lng: 77.6245 };

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  koramangala = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
  restaurantId = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: koramangala } }))
    .restaurantId;
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  ctx.clock.set(todayAt('13:00'));
});

async function item(name: string) {
  return ctx.prisma.foodItem.findFirstOrThrow({ where: { name, restaurantId } });
}

/** Simulates a restaurant availability edit (Phase 8 writers bump the version the same way). */
async function setAvailability(
  foodItemId: string,
  isAvailable: boolean,
  unavailableUntil: Date | null,
) {
  await ctx.prisma.branchItemAvailability.upsert({
    where: { branchId_foodItemId: { branchId: koramangala, foodItemId } },
    create: { branchId: koramangala, foodItemId, isAvailable, unavailableUntil },
    update: { isAvailable, unavailableUntil },
  });
  await ctx.prisma.branch.update({
    where: { id: koramangala },
    data: { menuVersion: { increment: 1 } },
  });
}

suite('restaurant and branch pages (API-REST-001…005, FR-MENUC-001)', () => {
  it('returns brand info with cuisines and a "New" rating', async () => {
    const res = await browser(ctx).get(`/restaurants/${restaurantId}`);
    expect(res.body.data).toMatchObject({
      name: 'Saffron Handi Biryani',
      cuisines: expect.arrayContaining([expect.objectContaining({ slug: 'biryani' })]),
      rating: { average: null, isNew: true },
      isFavorite: false,
    });
  });

  it('lists the brand branches nearest first with delivery info', async () => {
    const res = await browser(ctx).get(`/restaurants/${restaurantId}/branches`, HOME);
    expect(res.body.data.map((b: { branchName: string }) => b.branchName)).toEqual([
      'Koramangala',
      'Indiranagar',
    ]);
    expect(res.body.data[0].delivery).toMatchObject({ serviceable: true });
    expect(res.body.data[1].delivery).toMatchObject({ serviceable: false, reason: 'OUTSIDE_ZONE' });
  });

  it('builds the branch header: status, hours, FSSAI and delivery details', async () => {
    const res = await browser(ctx).get(`/branches/${koramangala}`, HOME);
    expect(res.body.data).toMatchObject({
      branchName: 'Koramangala',
      status: { state: 'OPEN', acceptingOrders: true },
      fssaiNumber: '11223344556601',
      hours: { today: { slots: [{ opensAt: '11:30', closesAt: '23:30' }] } },
      deliveryDetails: { serviceable: true, minOrderAmount: expect.any(Number) },
      offers: [],
    });
    expect(res.body.data.hours.week).toHaveLength(7);
    expect((await browser(ctx).get(`/branches/${koramangala}`, { lat: 12.9 })).status).toBe(400); // lat without lng
  });

  it('serves hours and delivery info, which needs a location', async () => {
    expect((await browser(ctx).get(`/branches/${koramangala}/hours`)).body.data.week[0].name).toBe(
      'Sunday',
    );
    expect((await browser(ctx).get(`/branches/${koramangala}/delivery-info`)).status).toBe(400);
    const info = await browser(ctx).get(`/branches/${koramangala}/delivery-info`, HOME);
    expect(info.body.data).toMatchObject({
      serviceable: true,
      deliveryFeeAmount: 1900,
      platformFeeAmount: 500,
    });
  });

  it('hides unknown and unapproved branches', async () => {
    expect((await browser(ctx).get('/branches/01900000-0000-7000-8000-000000000000')).status).toBe(
      404,
    );
    await ctx.prisma.branch.update({ where: { id: koramangala }, data: { status: 'SUSPENDED' } });
    try {
      expect((await browser(ctx).get(`/branches/${koramangala}`)).status).toBe(404);
    } finally {
      await ctx.prisma.branch.update({ where: { id: koramangala }, data: { status: 'ACTIVE' } });
    }
  });
});

suite('menu (API-MENU-001…007, FR-MENUC-002…008)', () => {
  it('groups items by category after smart sections, with prices and markers', async () => {
    const res = await browser(ctx).get(`/branches/${koramangala}/menu`);
    expect(res.status).toBe(200);
    const menu = res.body.data;
    expect(menu.sections.map((s: { key: string }) => s.key)).toContain('bestsellers');
    const all = menu.categories.flatMap((c: { items: unknown[] }) => c.items);
    const chicken = all.find((i: { name: string }) => i.name === 'Chicken Dum Biryani');
    expect(chicken).toMatchObject({
      priceAmount: 32900,
      dietaryMarker: 'NON_VEG',
      customizable: true,
      available: true,
    });
    expect(menu.sections.find((s: { key: string }) => s.key === 'bestsellers').itemIds).toContain(
      chicken.id,
    );
  });

  it('veg-only excludes non-veg and egg items (FR-DISC-008)', async () => {
    const res = await browser(ctx).get(`/branches/${koramangala}/menu`, { vegOnly: 'true' });
    const markers = res.body.data.categories.flatMap((c: { items: { dietaryMarker: string }[] }) =>
      c.items.map((i) => i.dietaryMarker),
    );
    expect(markers.length).toBeGreaterThan(0);
    expect(new Set(markers)).toEqual(new Set(['VEG']));
  });

  it('supports conditional requests with an ETag', async () => {
    const first = await browser(ctx).get(`/branches/${koramangala}/menu`);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^".+"$/);
    const again = await browser(ctx)
      .get(`/branches/${koramangala}/menu`)
      .set('If-None-Match', etag);
    expect(again.status).toBe(304);
    expect(await ctx.redis.cache.keys(`menu:v1:${koramangala}:*`)).toHaveLength(1);
  });

  it('greys out unavailable items and brings them back when the hold expires (FR-MENUC-005, BR-MENU-007)', async () => {
    const mutton = await item('Mutton Biryani');
    await setAvailability(mutton.id, false, todayAt('14:00'));
    try {
      const cards = (await browser(ctx).get(`/branches/${koramangala}/menu/items`, { q: 'mutton' }))
        .body.data;
      expect(cards[0]).toMatchObject({
        available: false,
        unavailableReason: 'UNAVAILABLE',
        availableAt: todayAt('14:00').toISOString(),
      });
      ctx.clock.set(todayAt('14:05')); // no menu edit needed: resolved per request
      const later = (await browser(ctx).get(`/branches/${koramangala}/menu/items`, { q: 'mutton' }))
        .body.data;
      expect(later[0]).toMatchObject({ available: true });
    } finally {
      await ctx.prisma.branchItemAvailability.delete({
        where: { branchId_foodItemId: { branchId: koramangala, foodItemId: mutton.id } },
      });
      await ctx.prisma.branch.update({
        where: { id: koramangala },
        data: { menuVersion: { increment: 1 } },
      });
    }
  });

  it('marks everything unorderable while the branch is closed, with the reopening time', async () => {
    ctx.clock.set(todayAt('09:00'));
    const cards = (await browser(ctx).get(`/branches/${koramangala}/menu/items`)).body.data;
    expect(
      cards.every((c: { unavailableReason: string }) => c.unavailableReason === 'BRANCH_CLOSED'),
    ).toBe(true);
    expect(cards[0].availableAt).toBe(todayAt('11:30').toISOString());
  });

  it('filters items and lists categories with counts', async () => {
    const veg = (await browser(ctx).get(`/branches/${koramangala}/menu/items`, { diet: 'VEG' }))
      .body.data;
    expect(veg.every((i: { dietaryMarker: string }) => i.dietaryMarker === 'VEG')).toBe(true);
    const best = (
      await browser(ctx).get(`/branches/${koramangala}/menu/items`, { flags: 'bestseller' })
    ).body.data;
    expect(best.length).toBeGreaterThan(0);
    expect(best.every((i: { isBestseller: boolean }) => i.isBestseller)).toBe(true);
    expect(
      (await browser(ctx).get(`/branches/${koramangala}/menu/items`, { flags: 'cheap' })).status,
    ).toBe(400);
    const cats = (await browser(ctx).get(`/branches/${koramangala}/menu/categories`)).body.data;
    expect(cats[0]).toMatchObject({ name: expect.any(String), itemCount: expect.any(Number) });
    expect(
      (await browser(ctx).get(`/branches/${koramangala}/menu/popular`)).body.data.length,
    ).toBeGreaterThan(0);
  });

  it('returns item details with variants and customisations, warning about the customer’s allergens', async () => {
    const chicken = await item('Chicken Dum Biryani');
    const guest = await browser(ctx).get(`/branches/${koramangala}/menu/items/${chicken.id}`);
    expect(guest.body.data).toMatchObject({
      variants: [
        expect.objectContaining({ name: 'Regular', isDefault: true }),
        expect.objectContaining({ priceAmount: 79900 }),
      ],
      allergens: ['MILK'],
      allergenWarnings: [],
    });
    const groups = guest.body.data.customizationGroups as {
      name: string;
      required: boolean;
      options: { name: string }[];
    }[];
    expect(groups.map((g) => g.name)).toEqual(['Spice level', 'Add-ons']);
    expect(groups[1]!.options.map((o) => o.name)).toContain('Boiled egg');

    const { browser: b } = await signUpCustomer(ctx);
    await b.patch('/me/preferences', { allergens: ['MILK'] });
    const mine = await b.get(`/branches/${koramangala}/menu/items/${chicken.id}`);
    expect(mine.body.data.allergenWarnings).toEqual(['MILK']);

    const custom = await browser(ctx).get(
      `/branches/${koramangala}/menu/items/${chicken.id}/customizations`,
    );
    expect(custom.body.data.customizationGroups).toHaveLength(2);
    expect(
      (
        await browser(ctx).get(
          `/branches/${koramangala}/menu/items/01900000-0000-7000-8000-000000000000`,
        )
      ).body.error.code,
    ).toBe('ITEM_NOT_FOUND');
  });
});
