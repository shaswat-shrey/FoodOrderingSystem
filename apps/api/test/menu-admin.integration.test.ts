import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  createOwnedRestaurant,
  createTestContext,
  integrationEnabled,
  SAFFRON_STAFF,
  signInAs,
  uploadFile,
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
});

type Owner = Awaited<ReturnType<typeof createOwnedRestaurant>>;
const R = (o: Owner, path = '') => `/merchant/restaurants/${o.restaurantId}${path}`;
const version = async (o: Owner) =>
  (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: o.branchId } })).menuVersion;

async function starter(o: Owner) {
  const b = o.browser;
  const mains = (await b.post(R(o, '/categories'), { name: 'Mains' })).body.data;
  const sides = (await b.post(R(o, '/categories'), { name: 'Sides' })).body.data;
  const item = (
    await b.post(R(o, '/items'), {
      categoryId: mains.id,
      name: 'Veg Thali',
      basePriceAmount: 24_900,
      dietaryMarker: 'VEG',
      tags: ['JAIN'],
      allergens: ['MILK'],
      ingredients: ['Rice', 'Dal'],
    })
  ).body.data;
  return { mains, sides, item };
}

suite('menu management (API-RMENU-001…026, FR-MENU-001…008)', () => {
  it('builds categories and dishes, reorders them and bumps the menu version', async () => {
    const o = await createOwnedRestaurant(ctx);
    const b = o.browser;
    const v0 = await version(o);
    const { mains, sides, item } = await starter(o);
    expect(item).toMatchObject({
      name: 'Veg Thali',
      tags: ['JAIN'],
      allergens: ['MILK'],
      ingredients: ['Rice', 'Dal'],
      version: 0,
    });
    expect(await version(o)).toBeGreaterThan(v0);

    await b.put(R(o, '/categories/order'), { categoryIds: [sides.id, mains.id] });
    expect((await b.put(R(o, '/categories/order'), { categoryIds: [sides.id] })).status).toBe(400);
    const second = (
      await b.post(R(o, '/items'), {
        categoryId: mains.id,
        name: 'Paneer Thali',
        basePriceAmount: 29_900,
        dietaryMarker: 'VEG',
      })
    ).body.data;
    await b.put(R(o, `/categories/${mains.id}/items/order`), { itemIds: [second.id, item.id] });
    const menu = (await b.get(R(o, '/menu'))).body.data;
    expect(menu.categories.map((c: { name: string }) => c.name)).toEqual(['Sides', 'Mains']);
    expect(menu.categories[1].items.map((i: { name: string }) => i.name)).toEqual([
      'Paneer Thali',
      'Veg Thali',
    ]);

    // BR-MENU-008: a non-empty category needs somewhere for its dishes to go.
    expect((await b.delete(R(o, `/categories/${mains.id}`))).status).toBe(400);
    expect(
      (await b.delete(`${R(o, `/categories/${mains.id}`)}?moveItemsTo=${sides.id}`)).status,
    ).toBe(200);
    expect((await b.get(R(o, '/menu'))).body.data.categories).toEqual([
      expect.objectContaining({ name: 'Sides', items: [expect.anything(), expect.anything()] }),
    ]);
  });

  it('enforces prices, offers, dietary rules and optimistic versions', async () => {
    const o = await createOwnedRestaurant(ctx);
    const b = o.browser;
    const { mains, item } = await starter(o);
    expect(
      (
        await b.post(R(o, '/items'), {
          categoryId: mains.id,
          name: 'Free',
          basePriceAmount: 50,
          dietaryMarker: 'VEG',
        })
      ).status,
    ).toBe(400);
    expect(
      (await b.patch(R(o, `/items/${item.id}`), { discountedPriceAmount: 24_900 })).body.error
        .details[0].path,
    ).toBe('discountedPriceAmount'); // BR-MENU-005
    const res = await b.patch(R(o, `/items/${item.id}`), { discountedPriceAmount: 19_900 });
    expect(res.headers.etag).toBe('"1"');
    // Stale If-Match loses.
    const stale = await b.agent
      .patch(`/api/v1${R(o, `/items/${item.id}`)}`)
      .set('X-Client-App', 'RESTAURANT')
      .set('Origin', 'http://localhost:5174')
      .set('Authorization', `Bearer ${b.token}`)
      .set('If-Match', '"0"')
      .send({ basePriceAmount: 25_900 });
    expect(stale.body.error.code).toBe('CONFLICT_STALE_VERSION');
    // Lowering the price under the offer is refused.
    expect((await b.patch(R(o, `/items/${item.id}`), { basePriceAmount: 15_000 })).status).toBe(
      400,
    );

    // BR-MENU-001: non-veg add-ons can't go on a veg dish.
    const extras = (
      await b.post(R(o, '/customization-groups'), {
        name: 'Extras',
        minSelect: 0,
        maxSelect: 2,
        options: [
          { name: 'Ghee', priceDeltaAmount: 2_000, dietaryMarker: 'VEG' },
          { name: 'Boiled egg', priceDeltaAmount: 2_500, dietaryMarker: 'EGG' },
        ],
      })
    ).body.data;
    expect(
      (
        await b.put(R(o, `/items/${item.id}/customization-groups`), {
          groups: [{ groupId: extras.id }],
        })
      ).status,
    ).toBe(400);
    const veg = (
      await b.post(R(o, '/customization-groups'), {
        name: 'Spice',
        minSelect: 1,
        maxSelect: 1,
        options: [
          { name: 'Mild', priceDeltaAmount: 0, dietaryMarker: 'VEG', isDefault: true },
          { name: 'Hot', priceDeltaAmount: 0, dietaryMarker: 'VEG' },
        ],
      })
    ).body.data;
    expect(veg).toMatchObject({ required: true });
    const attached = (
      await b.put(R(o, `/items/${item.id}/customization-groups`), { groups: [{ groupId: veg.id }] })
    ).body.data;
    expect(attached.customizationGroups).toEqual([expect.objectContaining({ groupId: veg.id })]);
    expect(
      (
        await b.post(R(o, `/customization-groups/${veg.id}/options`), {
          name: 'Chicken',
          priceDeltaAmount: 5_000,
          dietaryMarker: 'NON_VEG',
        })
      ).status,
    ).toBe(400);
    // BR-MENU-003: max can't exceed the options; can't drop below max.
    expect((await b.patch(R(o, `/customization-groups/${veg.id}`), { maxSelect: 3 })).status).toBe(
      400,
    );
    expect((await b.delete(R(o, `/customization-groups/${veg.id}`))).status).toBe(400); // attached

    // Pure-veg restaurants only list VEG dishes.
    const pure = await createOwnedRestaurant(ctx, { pureVeg: true });
    const cat = (await pure.browser.post(R(pure, '/categories'), { name: 'Mains' })).body.data;
    expect(
      (
        await pure.browser.post(R(pure, '/items'), {
          categoryId: cat.id,
          name: 'Egg curry',
          basePriceAmount: 19_900,
          dietaryMarker: 'EGG',
        })
      ).status,
    ).toBe(400);
  });

  it('keeps exactly one default variant (BR-MENU-004)', async () => {
    const o = await createOwnedRestaurant(ctx);
    const b = o.browser;
    const { item } = await starter(o);
    const half = (
      await b.post(R(o, `/items/${item.id}/variants`), { name: 'Half', priceAmount: 14_900 })
    ).body.data;
    expect(half.variants).toEqual([expect.objectContaining({ name: 'Half', isDefault: true })]);
    const full = (
      await b.post(R(o, `/items/${item.id}/variants`), {
        name: 'Full',
        priceAmount: 24_900,
        isDefault: true,
      })
    ).body.data;
    expect(
      full.variants.map((v: { name: string; isDefault: boolean }) => [v.name, v.isDefault]),
    ).toEqual([
      ['Half', false],
      ['Full', true],
    ]);
    const fullId = full.variants[1].id;
    expect(
      (await b.patch(R(o, `/items/${item.id}/variants/${fullId}`), { isDefault: false })).status,
    ).toBe(400);
    const after = (await b.delete(R(o, `/items/${item.id}/variants/${fullId}`))).body.data;
    expect(after.variants).toEqual([expect.objectContaining({ name: 'Half', isDefault: true })]);
  });

  it('adds up to five photos, reorders and removes them', async () => {
    const o = await createOwnedRestaurant(ctx);
    const b = o.browser;
    const { item } = await starter(o);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const img = await sharp({
        create: { width: 300, height: 300, channels: 3, background: { r: i * 40, g: 90, b: 90 } },
      })
        .jpeg()
        .toBuffer();
      const f = (await uploadFile(ctx, b, 'RESTAURANT', 'FOOD_IMAGE', img, `p${i}.jpg`)).body.data;
      ids.push(f.id);
      expect((await b.post(R(o, `/items/${item.id}/images`), { fileId: f.id })).status).toBe(201);
    }
    const extra = (
      await uploadFile(
        ctx,
        b,
        'RESTAURANT',
        'FOOD_IMAGE',
        await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
          .jpeg()
          .toBuffer(),
        'x.jpg',
      )
    ).body.data;
    expect((await b.post(R(o, `/items/${item.id}/images`), { fileId: extra.id })).status).toBe(400);
    const images = (await b.get(R(o, `/items/${item.id}`))).body.data.images as {
      id: string;
      fileId: string;
      urls: { thumb: string };
    }[];
    expect(images[0]!.urls.thumb).toMatch(/\.thumb\.webp$/);
    const reversed = [...images].reverse().map((i) => i.id);
    expect(
      (
        await b.put(R(o, `/items/${item.id}/images/order`), { imageIds: reversed })
      ).body.data.images.map((i: { id: string }) => i.id),
    ).toEqual(reversed);
    const after = (await b.delete(R(o, `/items/${item.id}/images/${images[0]!.id}`))).body.data;
    expect(after.images.map((i: { position: number }) => i.position)).toEqual([0, 1, 2, 3]);
    expect(
      (await ctx.prisma.file.findUniqueOrThrow({ where: { id: images[0]!.fileId } })).status,
    ).toBe('DELETED');
  });

  it('switches dishes and options off per branch until a time or the end of the day', async () => {
    const o = await createOwnedRestaurant(ctx);
    const b = o.browser;
    const { item } = await starter(o);
    const v0 = await version(o);
    const off = (
      await b.put(`/merchant/branches/${o.branchId}/items/${item.id}/availability`, {
        available: false,
        until: 'END_OF_DAY',
      })
    ).body.data;
    const t = localParts(ctx.clock.now(), 'Asia/Kolkata');
    expect(new Date(off.unavailableUntil).getTime()).toBe(
      zonedInstant(t.year, t.month, t.day + 1, 0, 'Asia/Kolkata').getTime(),
    );
    expect(await version(o)).toBe(v0 + 1);
    const menu = (await b.get(`${R(o, '/menu')}?branchId=${o.branchId}`)).body.data;
    expect(menu.categories[0].items[0]).toMatchObject({ available: false });
    ctx.clock.advance(12 * 3_600_000); // past midnight
    const fresh = await signInAs(
      ctx,
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).phone!,
    );
    expect(
      (await fresh.browser.get(`${R(o, '/menu')}?branchId=${o.branchId}`)).body.data.categories[0]
        .items[0].available,
    ).toBe(true);
    await fresh.browser.put(`/merchant/branches/${o.branchId}/items/${item.id}/availability`, {
      available: true,
    });
  });

  it('lets kitchen staff toggle availability but not edit the menu; others see nothing', async () => {
    const kitchen = await signInAs(ctx, SAFFRON_STAFF.kitchen);
    const kora = await ctx.prisma.branch.findFirstOrThrow({
      where: { name: 'Koramangala', restaurant: { brandName: 'Saffron Handi Biryani' } },
    });
    const rid = kora.restaurantId;
    const dessert = await ctx.prisma.foodItem.findFirstOrThrow({
      where: { restaurantId: rid, name: 'Double Ka Meetha' },
    });
    expect(
      (
        await kitchen.browser.put(
          `/merchant/branches/${kora.id}/items/${dessert.id}/availability`,
          { available: false },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await kitchen.browser.put(
          `/merchant/branches/${kora.id}/items/${dessert.id}/availability`,
          { available: true },
        )
      ).status,
    ).toBe(200);
    expect(
      (await kitchen.browser.post(`/merchant/restaurants/${rid}/categories`, { name: 'Nope' }))
        .status,
    ).toBe(403);
    const other = await createOwnedRestaurant(ctx);
    expect((await other.browser.get(`/merchant/restaurants/${rid}/menu`)).status).toBe(404);
    expect(
      (
        await other.browser.patch(`/merchant/restaurants/${rid}/items/${dessert.id}`, {
          name: 'Hacked',
        })
      ).status,
    ).toBe(404);
  });
});
