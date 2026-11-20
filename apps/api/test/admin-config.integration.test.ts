import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import type { RecordingJobQueue } from '../src/platform/jobs';
import {
  branchId,
  browser,
  createFixtureOrder,
  createTestContext,
  integrationEnabled,
  placeOrder,
  setPassword,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
let saffronRestaurant: string;
let southZone: string;
const ids: Record<string, string> = {};

const STAFF = {
  superAdmin: '+919000000001',
  admin: '+919000000002',
  support: '+919000000003',
} as const;
const PASSWORD = 'admin console passphrase';
const NEAR = { lat: 12.9355, lng: 77.6245 };
const key = () => ({ 'Idempotency-Key': uuidv7() });
const REASON = 'Configuration change for the test';

/** Mysuru, far from the seeded Bengaluru zones. */
const MYSURU = {
  type: 'Polygon',
  coordinates: [
    [
      [76.6, 12.28],
      [76.66, 12.28],
      [76.66, 12.33],
      [76.6, 12.33],
      [76.6, 12.28],
    ],
  ],
};
const IN_MYSURU = { lat: 12.3, lng: 76.63 };

/** Things this file changes that other files rely on; restored in afterAll. */
const createdZones: string[] = [];
const reviewsWritten: string[] = [];
let settingBefore: unknown;

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
  const branch = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });
  saffronRestaurant = branch.restaurantId;
  southZone = branch.zoneId;
  for (const i of await ctx.prisma.foodItem.findMany({
    where: { restaurantId: saffronRestaurant },
  }))
    ids[i.name] = i.id;
  for (const o of await ctx.prisma.customizationOption.findMany({
    where: { group: { restaurantId: saffronRestaurant } },
  }))
    ids[o.name] = o.id;
  settingBefore = (
    await ctx.prisma.platformSetting.findUnique({ where: { key: 'review.windowDays' } })
  )?.value;
});

afterAll(async () => {
  if (!integrationEnabled) return;
  // Other files sign the same staff in at the same manual clock time: lift this file's OTP cooldown.
  await ctx.prisma.otpCode.deleteMany({
    where: { userId: { in: [...signedIn.values()].map((s) => s.userId) } },
  });
  // Zones other files pick with findFirst({ status: 'ACTIVE' }) must stay the seeded ones.
  await ctx.prisma.zone.updateMany({
    where: { id: { in: createdZones } },
    data: { status: 'INACTIVE', deletedAt: new Date() },
  });
  await ctx.prisma.zone.update({
    where: { id: southZone },
    data: { surgeAmount: 0, surgeUntil: null, surgeReason: null },
  });
  if (settingBefore !== undefined)
    await ctx.prisma.platformSetting.update({
      where: { key: 'review.windowDays' },
      data: { value: settingBefore as number },
    });
  // Saffron's rating goes back to what the seed and other files expect.
  if (reviewsWritten.length) {
    await ctx.prisma.review.updateMany({
      where: { id: { in: reviewsWritten } },
      data: { deletedAt: new Date() },
    });
    // Branch only: the restaurant aggregate trips restaurants_rating_chk (scale mismatch, pre-existing).
    await ctx.container.reviews.recompute({ branchId: saffron });
  }
  await ctx.close();
});

beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
  (ctx.container.jobs as RecordingJobQueue).jobs.length = 0;
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
});

const signedIn = new Map<string, { browser: ReturnType<typeof browser>; userId: string }>();

/** Staff into the admin app through the emailed second factor. */
async function adminSignIn(phone: string) {
  const user = await ctx.prisma.user.findFirstOrThrow({ where: { phone } });
  // Another file may have signed this person in at the same manual clock time (OTP resend cooldown).
  await ctx.prisma.otpCode.deleteMany({ where: { userId: user.id } });
  await setPassword(ctx.prisma, user.id, PASSWORD);
  const b = browser(ctx, 'ADMIN');
  const first = await b.post('/auth/login', { identifier: phone, password: PASSWORD });
  expect(first.body.data?.mfaRequired, JSON.stringify(first.body)).toBe(true);
  const code = ctx.messages.lastOtp(user.email!)!;
  const done = b.remember(
    await b.post('/auth/mfa/challenge', { mfaToken: first.body.data.mfaToken, code }),
  );
  expect(done.status).toBe(200);
  return { browser: b, userId: user.id };
}

/** Seeded staff, signed in once per file. */
async function staff(phone: string) {
  const known = signedIn.get(phone);
  if (known) return known;
  const result = await adminSignIn(phone);
  signedIn.set(phone, result);
  return result;
}

const audited = (action: string, targetId: string) =>
  ctx.prisma.auditLog.findFirst({ where: { action, targetId }, orderBy: { createdAt: 'desc' } });

const order = (coupon?: string) =>
  placeOrder(ctx, {
    branchId: saffron,
    items: [{ foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 2 }],
    paymentMethod: 'COD',
    ...(coupon ? { coupon } : {}),
  });

suite('coupons (API-ADM-100…105, FR-ADMIN-060)', () => {
  it('rejects bad terms, prices a new coupon at checkout, lists redemptions and deactivates', async () => {
    const admin = await staff(STAFF.admin);
    const endsAt = new Date(ctx.clock.now().getTime() + 7 * 86_400_000).toISOString();
    const code = `ADM${Date.now().toString(36).toUpperCase()}`.slice(0, 20);

    // BR-COUPON-004: a percentage coupon needs a cap; restaurant-funded coupons name restaurants.
    const bad = await admin.browser.post('/admin/coupons', {
      code,
      description: 'Ten percent off',
      discountType: 'PERCENT',
      value: 1000,
      funding: 'RESTAURANT',
      endsAt,
      reason: REASON,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'maxDiscountAmount',
      'restaurantIds',
    ]);
    const noReason = await admin.browser.post('/admin/coupons', {
      code,
      description: 'Flat fifty',
      discountType: 'FLAT',
      value: 5000,
      endsAt,
    });
    expect(noReason.status).toBe(400);

    const created = await admin.browser.post('/admin/coupons', {
      code: code.toLowerCase(),
      description: 'Ten percent off, up to ₹50',
      discountType: 'PERCENT',
      value: 1000,
      maxDiscountAmount: 5000,
      usageLimitTotal: 10,
      endsAt,
      reason: REASON,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const coupon = created.body.data;
    expect(coupon).toMatchObject({ code, status: 'ACTIVE', funding: 'PLATFORM' });
    expect(await audited('admin.coupon_created', coupon.id)).toMatchObject({
      sensitivity: 'HIGH',
      reason: REASON,
    });
    const dupe = await admin.browser.post('/admin/coupons', {
      code,
      description: 'Again',
      discountType: 'FLAT',
      value: 5000,
      endsAt,
      reason: REASON,
    });
    expect(dupe.status).toBe(409);

    // The checkout prices it like any other coupon.
    const o = await order(code);
    const placed = await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(placed.couponId).toBe(coupon.id);
    expect(placed.discountTotalAmount).toBeGreaterThan(0);
    expect(placed.discountTotalAmount).toBeLessThanOrEqual(5000);

    const redemptions = await admin.browser.get(`/admin/coupons/${coupon.id}/redemptions`);
    expect(redemptions.body.data).toHaveLength(1);
    expect(redemptions.body.data[0]).toMatchObject({
      order: { id: o.orderId },
      customer: { phone: `+91XXXXXX${o.phone.slice(-4)}` },
      discountAmount: placed.discountTotalAmount,
    });
    const detail = (await admin.browser.get(`/admin/coupons/${coupon.id}`)).body.data;
    expect(detail.stats.reserved + detail.stats.redeemed).toBe(1);
    expect(
      (await admin.browser.get('/admin/coupons', { q: code })).body.data.map(
        (c: { id: string }) => c.id,
      ),
    ).toEqual([coupon.id]);

    // BR-COUPON-009: terms are locked once used; descriptions and limits are not.
    const locked = await admin.browser.patch(`/admin/coupons/${coupon.id}`, {
      value: 2000,
      reason: REASON,
    });
    expect(locked.status).toBe(409);
    const edited = await admin.browser.patch(`/admin/coupons/${coupon.id}`, {
      description: 'Ten percent off (extended)',
      usageLimitTotal: 20,
      reason: REASON,
    });
    expect(edited.body.data).toMatchObject({ usageLimitTotal: 20, version: 1 });
    expect(
      (
        await admin.browser.patch(`/admin/coupons/${coupon.id}`, {
          usageLimitTotal: 0,
          reason: REASON,
        })
      ).status,
    ).toBe(400);

    const off = await admin.browser.post(`/admin/coupons/${coupon.id}/deactivate`, {
      reason: REASON,
    });
    expect(off.body.data.status).toBe('INACTIVE');
    expect(
      (await admin.browser.post(`/admin/coupons/${coupon.id}/deactivate`, { reason: REASON }))
        .status,
    ).toBe(409);
    const late = await signUpCustomer(ctx);
    await late.browser.post('/cart/items', {
      branchId: saffron,
      foodItemId: ids['Paneer Biryani']!,
      optionIds: [ids.Mild!],
      quantity: 2,
    });
    const refused = await late.browser.post('/cart/coupon', { code });
    expect(refused.body.error?.code).toBe('COUPON_INVALID');
  });
});

suite('zones (API-ADM-120…126, FR-ADMIN-070)', () => {
  it('validates polygons, suspends and restores serviceability, and sets surge', async () => {
    const admin = await staff(STAFF.admin);
    const create = (polygon: unknown, name = 'Mysuru Central') =>
      admin.browser.post('/admin/zones', { name, city: 'Mysuru', polygon, reason: REASON });

    const ring = MYSURU.coordinates[0]!;
    const notClosed = await create({ type: 'Polygon', coordinates: [ring.slice(0, 4)] });
    expect(notClosed.body.error.details[0].code).toBe('NOT_CLOSED');
    const bowTie = await create({
      type: 'Polygon',
      coordinates: [
        [
          [76.6, 12.28],
          [76.66, 12.33],
          [76.66, 12.28],
          [76.6, 12.33],
          [76.6, 12.28],
        ],
      ],
    });
    expect(bowTie.body.error.details[0].code).toBe('SELF_INTERSECTING');
    const abroad = await create({
      type: 'Polygon',
      coordinates: [
        [
          [55.2, 25.2],
          [55.3, 25.2],
          [55.3, 25.3],
          [55.2, 25.2],
        ],
      ],
    });
    expect(abroad.body.error.details[0].code).toBe('OUTSIDE_INDIA');
    const overlapping = await create(
      {
        type: 'Polygon',
        coordinates: [
          [
            [77.62, 12.92],
            [77.64, 12.92],
            [77.64, 12.94],
            [77.62, 12.92],
          ],
        ],
      },
      'Overlaps Koramangala',
    );
    expect(overlapping.status).toBe(409);

    const created = await create(MYSURU);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const zone = created.body.data;
    createdZones.push(zone.id);
    expect(zone).toMatchObject({ status: 'ACTIVE', city: 'Mysuru', branchCount: 0 });
    expect(zone.areaKm2).toBeGreaterThan(30);
    expect(zone.polygon.coordinates[0]).toHaveLength(5);

    const guest = browser(ctx);
    const check = async () =>
      (await guest.get('/geo/serviceability', IN_MYSURU)).body.data as {
        serviceable: boolean;
        reason: string | null;
      };
    expect(await check()).toMatchObject({ serviceable: true });

    // Support agents can see zones but not change them.
    const support = await staff(STAFF.support);
    expect(
      (await support.browser.post(`/admin/zones/${zone.id}/suspend`, { reason: REASON })).status,
    ).toBe(403);

    const before = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });
    const suspended = await admin.browser.post(`/admin/zones/${zone.id}/suspend`, {
      reason: 'Heavy rain in Mysuru',
    });
    expect(suspended.body.data).toMatchObject({
      status: 'SUSPENDED',
      suspensionReason: 'Heavy rain in Mysuru',
    });
    expect(await check()).toMatchObject({ serviceable: false, reason: 'ZONE_SUSPENDED' });
    expect(
      (await admin.browser.post(`/admin/zones/${zone.id}/suspend`, { reason: REASON })).status,
    ).toBe(409);
    await admin.browser.post(`/admin/zones/${zone.id}/activate`, { reason: 'Rain has stopped' });
    expect(await check()).toMatchObject({ serviceable: true, reason: null });
    expect(await audited('admin.zone_suspended', zone.id)).toMatchObject({ sensitivity: 'HIGH' });

    const patched = await admin.browser.patch(`/admin/zones/${zone.id}`, {
      maxDeliveryRadiusM: 5000,
      name: 'Mysuru',
      reason: REASON,
    });
    expect(patched.body.data).toMatchObject({ maxDeliveryRadiusM: 5000, name: 'Mysuru' });
    expect((await admin.browser.get('/admin/zones', { city: 'Mysuru' })).body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: zone.id })]),
    );
    // Shrinking Koramangala's zone away from its branches is refused.
    const shrink = await admin.browser.patch(`/admin/zones/${southZone}`, {
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [75.1, 15.3],
            [75.2, 15.3],
            [75.2, 15.4],
            [75.1, 15.3],
          ],
        ],
      },
      reason: REASON,
    });
    expect(shrink.body.error?.details?.[0]?.code).toBe('BRANCHES_OUTSIDE');

    // BR-PRICE-007: surge ≤ ₹40 for ≤ 3 h, shown in the delivery quote.
    const until = new Date(ctx.clock.now().getTime() + 2 * 3_600_000).toISOString();
    expect(
      (
        await admin.browser.put(`/admin/zones/${southZone}/surge`, {
          amount: 2500,
          until: new Date(ctx.clock.now().getTime() + 4 * 3_600_000).toISOString(),
          label: 'Heavy rain',
          reason: REASON,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin.browser.put(`/admin/zones/${southZone}/surge`, {
          amount: 5000,
          until,
          label: 'Heavy rain',
          reason: REASON,
        })
      ).status,
    ).toBe(400);
    const surge = await admin.browser.put(`/admin/zones/${southZone}/surge`, {
      amount: 2500,
      until,
      label: 'Heavy rain',
      reason: REASON,
    });
    expect(surge.body.data.surge).toMatchObject({
      active: true,
      amount: 2500,
      reason: 'Heavy rain',
    });
    const after = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });
    expect(after.menuVersion).toBeGreaterThan(before.menuVersion);
    const quote = (await guest.get('/geo/serviceability', { ...NEAR, branchId: saffron })).body
      .data;
    expect(quote.branch.surge).toEqual({ amount: 2500, reason: 'Heavy rain' });
    const o = await order();
    expect(
      await ctx.prisma.orderPriceComponent.findFirst({
        where: { orderId: o.orderId, type: 'SURGE' },
      }),
    ).toMatchObject({ amount: 2500 });

    await admin.browser.put(`/admin/zones/${southZone}/surge`, { amount: 0, reason: REASON });
    const cleared = (await guest.get('/geo/serviceability', { ...NEAR, branchId: saffron })).body
      .data;
    expect(cleared.branch.surge).toEqual({ amount: 0, reason: null });
  });
});

suite('settings (API-ADM-130…132, FR-ADMIN-100, FR-CFG-001)', () => {
  it('validates by schema, keeps history and guards critical keys', async () => {
    const admin = await staff(STAFF.admin);
    const list = (await admin.browser.get('/admin/settings')).body.data as {
      key: string;
      value: unknown;
      default: unknown;
      description: string;
      critical: boolean;
    }[];
    const window = list.find((s) => s.key === 'review.windowDays')!;
    expect(window).toMatchObject({ default: 7, description: expect.any(String), critical: false });
    expect(list.find((s) => s.key === 'cod.maxOrderAmount')).toMatchObject({ critical: true });

    expect(
      (
        await admin.browser.patch('/admin/settings/review.windowDays', {
          value: 'ten',
          reason: REASON,
        })
      ).body.error.code,
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await admin.browser.patch('/admin/settings/review.windowDays', {
          value: 99,
          reason: REASON,
        })
      ).status,
    ).toBe(400);
    expect(
      (await admin.browser.patch('/admin/settings/no.such.key', { value: 1, reason: REASON }))
        .status,
    ).toBe(404);
    // Critical keys are super-admin only; support agents can't write settings at all.
    expect(
      (
        await admin.browser.patch('/admin/settings/cod.maxOrderAmount', {
          value: 100_000,
          reason: REASON,
        })
      ).status,
    ).toBe(403);
    const support = await staff(STAFF.support);
    expect(
      (
        await support.browser.patch('/admin/settings/review.windowDays', {
          value: 10,
          reason: REASON,
        })
      ).status,
    ).toBe(403);

    const updated = await admin.browser.patch('/admin/settings/review.windowDays', {
      value: 10,
      reason: 'Longer review window',
    });
    expect(updated.body.data).toMatchObject({ key: 'review.windowDays', value: 10 });
    expect(await ctx.container.settings.get('review.windowDays')).toBe(10);
    await admin.browser.patch('/admin/settings/review.windowDays', {
      value: window.value,
      reason: 'Back to the default window',
    });
    const history = (await admin.browser.get('/admin/settings/review.windowDays/history')).body
      .data;
    expect(history.slice(0, 2)).toMatchObject([
      { oldValue: 10, newValue: window.value, reason: 'Back to the default window' },
      { newValue: 10, reason: 'Longer review window', changedBy: { id: expect.any(String) } },
    ]);
    expect(await audited('admin.setting_updated', 'review.windowDays')).toMatchObject({
      sensitivity: 'HIGH',
    });
  });
});

suite('pricing tables (API-ADM-133…140, FR-ADMIN-071…073)', () => {
  it('adds future-dated versions only, super admin only', async () => {
    const superAdmin = await staff(STAFF.superAdmin);
    const admin = await staff(STAFF.admin);
    const zone = await ctx.prisma.zone.findFirstOrThrow({ where: { id: { in: createdZones } } });
    // Far enough ahead that no other file's clock reaches it (versions can't be deleted).
    const future = new Date(ctx.clock.now().getTime() + 400 * 86_400_000).toISOString();
    const past = new Date(ctx.clock.now().getTime() - 86_400_000).toISOString();
    const schedule = {
      zoneId: zone.id,
      platformFeeAmount: 600,
      smallOrderThresholdAmount: 14_900,
      smallOrderFeeAmount: 1_500,
      perKmBeyondSlabsAmount: 800,
      packagingCapPerItemAmount: 1_000,
      packagingCapPerOrderAmount: 5_000,
      surgeCapAmount: 4_000,
      slabs: [
        { fromM: 0, toM: 3000, feeAmount: 2000 },
        { fromM: 3000, toM: 7000, feeAmount: 3500 },
      ],
      reason: REASON,
    };
    expect(
      (await admin.browser.post('/admin/fee-schedules', { ...schedule, effectiveFrom: future }))
        .status,
    ).toBe(403);
    expect(
      (
        await superAdmin.browser.post('/admin/fee-schedules', {
          ...schedule,
          effectiveFrom: past,
        })
      ).body.error.details[0].code,
    ).toBe('PAST');
    expect(
      (
        await superAdmin.browser.post('/admin/fee-schedules', {
          ...schedule,
          slabs: [{ fromM: 500, toM: 3000, feeAmount: 2000 }],
          effectiveFrom: future,
        })
      ).status,
    ).toBe(400);
    const created = await superAdmin.browser.post('/admin/fee-schedules', {
      ...schedule,
      effectiveFrom: future,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ state: 'SCHEDULED', zoneId: zone.id });
    const list = (await admin.browser.get('/admin/fee-schedules', { zoneId: zone.id })).body.data;
    expect(list.map((s: { state: string }) => s.state)).toEqual(
      expect.arrayContaining(['SCHEDULED', 'IN_EFFECT']),
    );
    expect(await audited('admin.fee_schedule_created', created.body.data.id)).toMatchObject({
      sensitivity: 'HIGH',
    });

    const tax = await superAdmin.browser.post('/admin/tax-rules', {
      component: 'PLATFORM_FEE',
      rateBps: 1800,
      collectedBy: 'PLATFORM',
      effectiveFrom: future,
      reason: REASON,
    });
    expect(tax.body.data).toMatchObject({ state: 'SCHEDULED', taxCode: 'GST' });
    const plan = await superAdmin.browser.post('/admin/commission-plans', {
      name: 'Next year',
      rateBps: 1800,
      effectiveFrom: future,
      reason: REASON,
    });
    expect(plan.body.data).toMatchObject({ state: 'SCHEDULED', rateBps: 1800 });
    const commissions = (await admin.browser.get('/admin/commission-plans')).body.data;
    expect(commissions.filter((c: { state: string }) => c.state === 'IN_EFFECT')).toHaveLength(1);
    const pay = await superAdmin.browser.post('/admin/partner-pay-plans', {
      zoneId: zone.id,
      baseAmount: 3000,
      perKmAmount: 700,
      freeKmM: 2000,
      waitAfterMinutes: 10,
      perWaitMinuteAmount: 100,
      waitCapAmount: 3000,
      rainBonusAmount: 2000,
      cancellationMinAmount: 1500,
      effectiveFrom: future,
      reason: REASON,
    });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.data).toMatchObject({ state: 'SCHEDULED', zoneId: zone.id });
    const again = await superAdmin.browser.post('/admin/partner-pay-plans', {
      zoneId: zone.id,
      baseAmount: 3000,
      perKmAmount: 700,
      freeKmM: 2000,
      waitAfterMinutes: 10,
      perWaitMinuteAmount: 100,
      waitCapAmount: 3000,
      rainBonusAmount: 500, // BR-EARN-001: ₹10–₹30 or none
      cancellationMinAmount: 1500,
      effectiveFrom: future,
      reason: REASON,
    });
    expect(again.status).toBe(400);
  });
});

suite('support desk (API-ADM-150…155, FR-ADMIN-080)', () => {
  it('replies, keeps internal notes private, assigns, updates and escalates', async () => {
    const customer = await signUpCustomer(ctx);
    const opened = await customer.browser.post(
      '/support/tickets',
      { category: 'PAYMENT', description: 'I was charged twice for my order yesterday.' },
      key(),
    );
    expect(opened.status).toBe(201);
    const ticketId = opened.body.data.id as string;
    const support = await staff(STAFF.support);
    const admin = await staff(STAFF.admin);

    const queue = await support.browser.get('/admin/tickets', {
      queue: 'UNASSIGNED',
      category: 'PAYMENT',
      pageSize: 100,
    });
    expect(queue.body.data.map((t: { id: string }) => t.id)).toContain(ticketId);

    const note = await support.browser.post(`/admin/tickets/${ticketId}/messages`, {
      body: 'Checked the gateway: one charge is pending reversal.',
      internal: true,
    });
    expect(note.status).toBe(201);
    const reply = await support.browser.post(`/admin/tickets/${ticketId}/messages`, {
      body: 'Sorry about that — the second charge will be reversed within 5 days.',
    });
    expect(reply.body.data).toMatchObject({
      status: 'PENDING_CUSTOMER',
      assignee: { id: support.userId },
    });
    expect(reply.body.data.messages.map((m: { internal: boolean }) => m.internal)).toEqual([
      false,
      true,
      false,
    ]);

    // The customer sees the reply, never the note, and is notified.
    const mine = (await customer.browser.get(`/support/tickets/${ticketId}`)).body.data;
    expect(mine.messages.map((m: { from: string }) => m.from)).toEqual(['YOU', 'SUPPORT']);
    expect(JSON.stringify(mine)).not.toContain('pending reversal');
    await ctx.container.outboxRelay.runOnce();
    const inbox = (await customer.browser.get('/me/notifications')).body.data as {
      title: string;
    }[];
    expect(inbox.map((n) => n.title)).toContain('Support replied');

    // Only staff who work tickets can own them.
    expect(
      (
        await support.browser.post(`/admin/tickets/${ticketId}/assign`, {
          assigneeId: customer.userId,
        })
      ).status,
    ).toBe(400);
    const assigned = await support.browser.post(`/admin/tickets/${ticketId}/assign`, {
      assigneeId: admin.userId,
    });
    expect(assigned.body.data.assignee.id).toBe(admin.userId);
    expect(
      (await admin.browser.get('/admin/tickets', { queue: 'MINE', pageSize: 100 })).body.data.map(
        (t: { id: string }) => t.id,
      ),
    ).toContain(ticketId);

    const patched = await admin.browser.patch(`/admin/tickets/${ticketId}`, {
      priority: 'LOW',
      category: 'REFUND',
    });
    expect(patched.body.data).toMatchObject({ priority: 'LOW', category: 'REFUND' });
    const escalated = await admin.browser.post(`/admin/tickets/${ticketId}/escalate`, {
      reason: 'Customer is waiting on a double charge',
    });
    expect(escalated.body.data).toMatchObject({ priority: 'NORMAL', status: 'PENDING_INTERNAL' });
    expect(escalated.body.data.messages.at(-1)).toMatchObject({
      internal: true,
      body: expect.stringContaining('Escalated (LOW → NORMAL)'),
    });

    const resolved = await admin.browser.patch(`/admin/tickets/${ticketId}`, {
      status: 'RESOLVED',
    });
    expect(resolved.body.data).toMatchObject({
      status: 'RESOLVED',
      resolvedAt: expect.any(String),
    });
    expect(
      (await admin.browser.post(`/admin/tickets/${ticketId}/messages`, { body: 'One more thing' }))
        .body.error.code,
    ).toBe('TICKET_STATE_CONFLICT');
    expect(
      (
        await admin.browser.get('/admin/tickets', { status: 'RESOLVED', pageSize: 100 })
      ).body.data.map((t: { id: string }) => t.id),
    ).toContain(ticketId);
    expect(await audited('admin.ticket_escalated', ticketId)).toMatchObject({
      reason: 'Customer is waiting on a double charge',
    });
    const events = await ctx.prisma.outboxEvent.findMany({
      where: { aggregateId: ticketId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining([
        'ticket.agent_replied',
        'ticket.assigned',
        'ticket.updated',
        'ticket.escalated',
      ]),
    );
  });
});

suite('review moderation (API-ADM-163…165, FR-ADMIN-082)', () => {
  it('hides and restores a reported review, moving the branch rating', async () => {
    const author = await signUpCustomer(ctx);
    const { orderId } = await createFixtureOrder(ctx, {
      userId: author.userId,
      branchId: saffron,
      status: 'DELIVERED',
      paymentMethod: 'COD',
    });
    const unrated = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });
    const submitted = await author.browser.post(
      `/orders/${orderId}/reviews`,
      { restaurant: { rating: 1, text: 'Cold and late' } },
      key(),
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const reviewId = submitted.body.data[0].id as string;
    reviewsWritten.push(reviewId);
    await ctx.container.outboxRelay.runOnce();
    const rated = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });

    const reporter = await signUpCustomer(ctx);
    expect(
      (
        await reporter.browser.post(
          `/reviews/${reviewId}/reports`,
          { reason: 'FAKE', note: 'Never ordered' },
          key(),
        )
      ).status,
    ).toBe(201);

    const admin = await staff(STAFF.admin);
    const reported = await admin.browser.get('/admin/reviews/reports', { pageSize: 100 });
    const entry = reported.body.data.find((r: { id: string }) => r.id === reviewId);
    expect(entry).toMatchObject({
      status: 'PUBLISHED',
      reports: { count: 1, reasons: { FAKE: 1 } },
    });

    expect((await admin.browser.post(`/admin/reviews/${reviewId}/hide`, {})).status).toBe(400); // ★ needs a reason
    const hidden = await admin.browser.post(`/admin/reviews/${reviewId}/hide`, {
      reason: 'Reviewer did not order',
    });
    expect(hidden.body.data).toMatchObject({ status: 'HIDDEN', reportsResolved: 1 });
    await ctx.container.outboxRelay.runOnce();
    const afterHide = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });
    expect(rated.ratingCount).toBe(unrated.ratingCount + 1);
    expect(afterHide).toMatchObject({
      ratingCount: unrated.ratingCount,
      ratingAvgBps: unrated.ratingAvgBps,
    });
    expect(await ctx.prisma.reviewReport.findFirst({ where: { reviewId } })).toMatchObject({
      status: 'UPHELD',
    });
    expect(
      (await admin.browser.post(`/admin/reviews/${reviewId}/hide`, { reason: REASON })).status,
    ).toBe(409);
    expect(
      (
        await admin.browser.get('/admin/reviews/reports', { status: 'UPHELD', pageSize: 100 })
      ).body.data.map((r: { id: string }) => r.id),
    ).toContain(reviewId);

    const restored = await admin.browser.post(`/admin/reviews/${reviewId}/unhide`, {
      reason: 'Order confirmed on appeal',
    });
    expect(restored.body.data).toMatchObject({ status: 'PUBLISHED' });
    await ctx.container.outboxRelay.runOnce();
    const afterRestore = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });
    expect(afterRestore).toMatchObject({
      ratingCount: rated.ratingCount,
      ratingAvgBps: rated.ratingAvgBps,
    });
    expect(await audited('admin.review_restored', reviewId)).toMatchObject({
      sensitivity: 'HIGH',
      reason: 'Order confirmed on appeal',
    });
    const support = await staff(STAFF.support);
    expect((await support.browser.get('/admin/reviews/reports')).status).toBe(403);
  });
});

suite('content: cuisines (API-ADM-196…198)', () => {
  it('creates, renames and deactivates a cuisine', async () => {
    const admin = await staff(STAFF.admin);
    const name = `Coorgi ${Date.now().toString(36)}`;
    const created = await admin.browser.post('/admin/cuisines', { name });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name, isActive: true, restaurantCount: 0 });
    expect((await admin.browser.post('/admin/cuisines', { name })).status).toBe(409);
    const off = await admin.browser.patch(`/admin/cuisines/${created.body.data.id}`, {
      isActive: false,
    });
    expect(off.body.data).toMatchObject({ isActive: false });
    expect((await admin.browser.get('/admin/cuisines')).body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.data.id })]),
    );
  });
});

suite('roles (API-ADM-180, 183…185, FR-ADMIN-110)', () => {
  it('grants and revokes staff roles with immediate effect, and guards the super admins', async () => {
    const superAdmin = await staff(STAFF.superAdmin);
    const admin = await staff(STAFF.admin);
    const roles = (await admin.browser.get('/admin/roles')).body.data as {
      key: string;
      permissions: string[];
      assignable: boolean;
    }[];
    expect(roles.find((r) => r.key === 'SUPER_ADMIN')).toMatchObject({ assignable: true });
    expect(roles.find((r) => r.key === 'SUPPORT_AGENT')!.permissions).toContain('support:write');
    expect(roles.find((r) => r.key === 'ADMIN')!.permissions).not.toContain('iam:assign');
    const perms = (await admin.browser.get('/admin/permissions')).body.data as {
      key: string;
      roles: string[];
    }[];
    expect(perms.find((p) => p.key === 'iam:assign')!.roles).toEqual(['SUPER_ADMIN']);

    // A new colleague with a verified email.
    const colleague = await signUpCustomer(ctx);
    await ctx.prisma.user.update({
      where: { id: colleague.userId },
      data: { emailVerifiedAt: new Date() },
    });
    const grant = (role: string, by = superAdmin) =>
      by.browser.post(`/admin/users/${colleague.userId}/roles`, { role, reason: REASON });
    expect((await grant('SUPPORT_AGENT', admin)).status).toBe(403); // iam:assign is super-admin only
    expect((await grant('CUSTOMER')).status).toBe(400);
    const granted = await grant('SUPPORT_AGENT');
    expect(granted.body.data.roles).toEqual(['CUSTOMER', 'SUPPORT_AGENT']);
    expect((await grant('SUPPORT_AGENT')).status).toBe(409);

    const agent = await adminSignIn(colleague.phone);
    expect((await agent.browser.get('/admin/tickets')).status).toBe(200);
    expect((await agent.browser.get('/admin/coupons')).status).toBe(403);
    await grant('ADMIN');
    // Same token: the permission version moved, so the next request sees ADMIN.
    expect((await agent.browser.get('/admin/coupons')).status).toBe(200);

    const revoke = (role: string, who = colleague.userId) =>
      superAdmin.browser.delete(`/admin/users/${who}/roles/${role}`).send({ reason: REASON });
    expect((await revoke('ADMIN')).body.data.roles).toEqual(['CUSTOMER', 'SUPPORT_AGENT']);
    expect((await agent.browser.get('/admin/coupons')).status).toBe(403);
    await revoke('SUPPORT_AGENT');
    expect([401, 403]).toContain((await agent.browser.get('/admin/tickets')).status);
    expect((await revoke('SUPPORT_AGENT')).status).toBe(404);
    expect(await audited('admin.role_revoked', colleague.userId)).toMatchObject({
      sensitivity: 'HIGH',
      reason: REASON,
    });

    // BR-ADMIN-001: nobody changes their own roles.
    expect((await revoke('SUPER_ADMIN', superAdmin.userId)).status).toBe(403);
    // BR-ADMIN-004: the last active super admin stays.
    await expect(
      ctx.container.adminGovernance.revokeRole(
        { userId: admin.userId, sessionId: uuidv7(), roles: ['SUPER_ADMIN'] },
        superAdmin.userId,
        'SUPER_ADMIN',
        REASON,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(
      await ctx.prisma.userRole.count({
        where: { userId: superAdmin.userId, role: { key: 'SUPER_ADMIN' } },
      }),
    ).toBe(1);
  });
});

suite('audit search and failed jobs (API-ADM-187, 202, 203)', () => {
  it('filters the audit trail and retries a dead job', async () => {
    const superAdmin = await staff(STAFF.superAdmin);
    const admin = await staff(STAFF.admin);
    const support = await staff(STAFF.support);

    const queue = ctx.container.jobs as RecordingJobQueue;
    const dead = queue.fail('notifications', 'deliver-notification', { id: 'x' }, 'SMTP down');
    expect((await support.browser.get('/admin/jobs/failed')).status).toBe(403);
    const failed = await admin.browser.get('/admin/jobs/failed', { queue: 'notifications' });
    expect(failed.body.data).toEqual([
      expect.objectContaining({
        id: dead.id,
        name: 'deliver-notification',
        failedReason: 'SMTP down',
      }),
    ]);
    expect(
      (await admin.browser.get('/admin/jobs/failed')).body.data.map((j: { id: string }) => j.id),
    ).toContain(dead.id);
    expect(
      (await admin.browser.post(`/admin/jobs/notifications/${dead.id}/retry`, {})).status,
    ).toBe(400);
    const retried = await admin.browser.post(`/admin/jobs/notifications/${dead.id}/retry`, {
      reason: 'SMTP is back',
    });
    expect(retried.body.data).toEqual({ queue: 'notifications', jobId: dead.id, retried: true });
    expect(queue.jobs).toEqual([
      expect.objectContaining({ queue: 'notifications', name: 'deliver-notification' }),
    ]);
    expect(
      (await admin.browser.post(`/admin/jobs/notifications/${dead.id}/retry`, { reason: REASON }))
        .status,
    ).toBe(404);

    const from = new Date(Date.now() - 60_000).toISOString();
    const logs = await superAdmin.browser.get('/admin/audit-logs', {
      action: 'admin.job_',
      actor: admin.userId,
      sensitivity: 'HIGH',
      from,
    });
    expect(logs.body.data[0]).toMatchObject({
      action: 'admin.job_retried',
      target: { type: 'job', id: `notifications:${dead.id}` },
      reason: 'SMTP is back',
      actor: { id: admin.userId },
    });
    const byTarget = await admin.browser.get('/admin/audit-logs', {
      targetType: 'setting',
      targetId: 'review.windowDays',
    });
    expect(byTarget.body.data.length).toBeGreaterThanOrEqual(2);
    expect(
      (
        await admin.browser.get('/admin/audit-logs', {
          action: 'admin.job_',
          to: new Date(Date.now() - 3_600_000).toISOString(),
          from: new Date(Date.now() - 7_200_000).toISOString(),
        })
      ).body.data,
    ).toHaveLength(0);
    expect((await support.browser.get('/admin/audit-logs')).status).toBe(403);

    // Support agents can't write configuration.
    expect(
      (
        await support.browser.post('/admin/coupons', {
          code: 'NOPE1234',
          description: 'x',
          discountType: 'FLAT',
          value: 100,
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: REASON,
        })
      ).status,
    ).toBe(403);
    expect((await support.browser.get('/admin/settings')).status).toBe(403);
  });
});
