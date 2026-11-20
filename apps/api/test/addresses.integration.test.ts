import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

beforeAll(async () => {
  if (integrationEnabled) ctx = await createTestContext();
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (integrationEnabled) await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
});

const home = {
  label: 'HOME',
  line1: 'Flat 4B, Lotus Residency',
  line2: '6th Cross',
  area: 'Koramangala',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560095',
  location: { lat: 12.9352, lng: 77.6245 },
};

suite('address book (API-ADDR-001…006, FR-ADDR-001…006, BR-ADDR-001/002)', () => {
  it('creates the first address as default with the account as contact', async () => {
    const { browser: b, phone } = await signUpCustomer(ctx);
    const res = await b.post('/me/addresses', home);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      label: 'HOME',
      isDefault: true,
      contactName: 'Test User',
      contactPhone: phone,
      location: home.location,
    });
  });

  it('allows one HOME and one WORK, any number of OTHER, up to the limit', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    await b.post('/me/addresses', home);
    const dup = await b.post('/me/addresses', { ...home, line1: 'Another' });
    expect(dup.status).toBe(422);
    expect(dup.body.error).toMatchObject({
      code: 'ADDRESS_INVALID',
      details: [expect.objectContaining({ path: 'label' })],
    });
    expect((await b.post('/me/addresses', { ...home, label: 'WORK' })).status).toBe(201);
    expect(
      (await b.post('/me/addresses', { ...home, label: 'OTHER', customLabel: 'Gym' })).status,
    ).toBe(201);
    expect((await b.get('/me/addresses')).body.data).toHaveLength(3);
  });

  it('enforces the 20-address limit (BR-ADDR-001)', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    for (let i = 0; i < 20; i++) {
      expect(
        (await b.post('/me/addresses', { ...home, label: 'OTHER', line1: `Flat ${i}` })).status,
      ).toBe(201);
    }
    const res = await b.post('/me/addresses', { ...home, label: 'OTHER' });
    expect(res.body.error.code).toBe('ADDRESS_INVALID');
  });

  it('requires a pin in India and a valid PIN code (BR-ADDR-002, FR-ADDR-006)', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const { location: _omit, ...noPin } = home;
    expect((await b.post('/me/addresses', noPin)).status).toBe(400);
    expect((await b.post('/me/addresses', { ...home, pincode: '05600' })).status).toBe(400);
    const abroad = await b.post('/me/addresses', { ...home, location: { lat: 40.7, lng: -74 } });
    expect(abroad.body.error.code).toBe('ADDRESS_INVALID');
  });

  it('updates, switches default, soft-deletes, and keeps addresses private', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const a = (await b.post('/me/addresses', home)).body.data;
    const w = (
      await b.post('/me/addresses', {
        ...home,
        label: 'WORK',
        location: { lat: 12.9719, lng: 77.6412 },
      })
    ).body.data;
    expect(w.isDefault).toBe(false);

    const moved = await b.patch(`/me/addresses/${a.id}`, {
      landmark: 'Opposite park',
      location: { lat: 12.936, lng: 77.625 },
    });
    expect(moved.body.data).toMatchObject({
      landmark: 'Opposite park',
      location: { lat: 12.936, lng: 77.625 },
      line1: home.line1,
    });

    expect((await b.post(`/me/addresses/${w.id}/default`)).body.data.isDefault).toBe(true);
    const list = (await b.get('/me/addresses')).body.data;
    expect(list.map((x: { id: string; isDefault: boolean }) => [x.id, x.isDefault])).toEqual([
      [w.id, true],
      [a.id, false],
    ]);

    expect((await b.delete(`/me/addresses/${w.id}`)).status).toBe(200);
    const after = (await b.get('/me/addresses')).body.data;
    expect(after).toHaveLength(1);
    expect(after[0].isDefault).toBe(false); // no default until one is chosen
    expect((await b.get(`/me/addresses/${w.id}`)).status).toBe(404);
    // A deleted HOME/WORK label can be reused.
    expect((await b.post('/me/addresses', { ...home, label: 'WORK' })).status).toBe(201);

    const stranger = await signUpCustomer(ctx);
    expect((await stranger.browser.get(`/me/addresses/${a.id}`)).status).toBe(404);
    expect((await stranger.browser.patch(`/me/addresses/${a.id}`, { landmark: 'x' })).status).toBe(
      404,
    );
  });

  it('reports per-address serviceability for a branch (FR-ADDR-002)', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    await b.post('/me/addresses', home); // Koramangala, blr-south
    await b.post('/me/addresses', {
      ...home,
      label: 'WORK',
      location: { lat: 12.9719, lng: 77.6412 },
    }); // Indiranagar
    const id = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
    const list = (await b.get('/me/addresses', { branchId: id })).body.data as {
      label: string;
      serviceability: { serviceable: boolean; reason: string | null };
    }[];
    expect(list.find((x) => x.label === 'HOME')!.serviceability.reason).not.toBe('OUTSIDE_ZONE');
    expect(list.find((x) => x.label === 'WORK')!.serviceability).toMatchObject({
      serviceable: false,
      reason: 'OUTSIDE_ZONE',
    });
  });

  it('is for signed-in customers with a verified phone', async () => {
    expect((await browser(ctx).get('/me/addresses')).status).toBe(401);
  });
});
