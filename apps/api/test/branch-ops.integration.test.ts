import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Branch, BranchOperatingHour } from '@fos/db';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  branchId,
  createTestContext,
  integrationEnabled,
  SAFFRON_STAFF,
  signInAs,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let bid: string;
let rid: string;
let snapshot: { branch: Branch; hours: BranchOperatingHour[] };

function todayAt(hm: string, addDays = 0): Date {
  const [h, m] = hm.split(':').map(Number);
  const t = localParts(new Date(), 'Asia/Kolkata');
  return zonedInstant(t.year, t.month, t.day + addDays, h! * 60 + m!, 'Asia/Kolkata');
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  bid = await branchId(ctx, 'Saffron Handi Biryani', 'Indiranagar');
  rid = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: bid } })).restaurantId;
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  ctx.clock.set(todayAt('13:00'));
  snapshot = {
    branch: await ctx.prisma.branch.findUniqueOrThrow({ where: { id: bid } }),
    hours: await ctx.prisma.branchOperatingHour.findMany({ where: { branchId: bid } }),
  };
});
afterEach(async () => {
  if (!integrationEnabled) return;
  const b = snapshot.branch;
  await ctx.prisma.branchHoliday.deleteMany({ where: { branchId: bid } });
  await ctx.prisma.branchOperatingHour.deleteMany({ where: { branchId: bid } });
  await ctx.prisma.branchOperatingHour.createMany({ data: snapshot.hours });
  await ctx.prisma.branch.update({
    where: { id: bid },
    data: {
      isOpenManual: b.isOpenManual,
      pausedUntil: b.pausedUntil,
      pauseReason: b.pauseReason,
      defaultPrepMinutes: b.defaultPrepMinutes,
      rushExtraMinutes: b.rushExtraMinutes,
      rushUntil: b.rushUntil,
      deliveryRadiusM: b.deliveryRadiusM,
      minOrderAmount: b.minOrderAmount,
      maxOrderAmount: b.maxOrderAmount,
      packagingFeeMode: b.packagingFeeMode,
      packagingFeeAmount: b.packagingFeeAmount,
      menuVersion: { increment: 1 },
    },
  });
});

suite('branch operations (API-MER-016…027, FR-REST-012…018)', () => {
  it('pauses with a reason, shows why, and resumes by itself when time is up', async () => {
    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    const b = manager.browser;
    expect((await b.get(`/merchant/branches/${bid}/status`)).body.data).toMatchObject({
      state: 'OPEN',
      acceptingOrders: true,
      label: 'Open',
    });
    const before = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: bid } })).menuVersion;
    const paused = (
      await b.post(`/merchant/branches/${bid}/pause`, { minutes: 30, reason: 'BUSY_KITCHEN' })
    ).body.data;
    expect(paused).toMatchObject({
      state: 'PAUSED',
      acceptingOrders: false,
      label: 'Paused until 13:30 (BUSY_KITCHEN)',
    });
    expect(
      (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: bid } })).menuVersion,
    ).toBeGreaterThan(before);
    // Customers see it as paused too.
    const customer = await signUpCustomer(ctx);
    expect((await customer.browser.get(`/branches/${bid}`)).body.data.status).toMatchObject({
      state: 'PAUSED',
    });

    ctx.clock.advance(31 * 60_000);
    expect(await ctx.container.branchOps.sweep()).toMatchObject({ resumed: 1 });
    expect(
      (
        await ctx.prisma.branchStatusEvent.findMany({
          where: { branchId: bid },
          orderBy: { createdAt: 'asc' },
        })
      ).map((e) => [e.event, e.actorId === null]),
    ).toEqual([
      ['PAUSED', false],
      ['RESUMED', true],
    ]);
    expect(
      (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: bid } })).pausedUntil,
    ).toBeNull();

    // "Until I resume" ends after 4 hours at most (BR-REST-002). (New sign-in: the clock moved.)
    const again = (await signInAs(ctx, SAFFRON_STAFF.manager)).browser;
    const indefinite = (
      await again.post(`/merchant/branches/${bid}/pause`, { reason: 'STAFF_SHORTAGE' })
    ).body.data;
    expect(new Date(indefinite.pausedUntil).getTime() - ctx.clock.now().getTime()).toBe(
      240 * 60_000,
    );
    expect((await again.post(`/merchant/branches/${bid}/resume`)).body.data.state).toBe('OPEN');
  });

  it('closes for today and reopens at the next day’s first slot', async () => {
    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    const closed = (await manager.browser.post(`/merchant/branches/${bid}/close`, {})).body.data;
    expect(closed).toMatchObject({ state: 'CLOSED', reason: 'MANUALLY_CLOSED', online: false });
    const event = await ctx.prisma.branchStatusEvent.findFirstOrThrow({
      where: { branchId: bid, event: 'CLOSED' },
    });
    const firstSlot = Math.min(
      ...snapshot.hours
        .filter((h) => h.weekday === new Date(todayAt('12:00', 1)).getUTCDay())
        .map((h) => h.opensAt.getUTCHours() * 60 + h.opensAt.getUTCMinutes()),
    );
    expect(event.until?.getTime()).toBe(
      todayAt(
        `${String(Math.floor(firstSlot / 60)).padStart(2, '0')}:${String(firstSlot % 60).padStart(2, '0')}`,
        1,
      ).getTime(),
    );
    expect(await ctx.container.branchOps.sweep()).toMatchObject({ reopened: 0 });
    ctx.clock.set(new Date(event.until!.getTime() + 60_000));
    expect(await ctx.container.branchOps.sweep()).toMatchObject({ reopened: 1 });
    expect((await ctx.prisma.branch.findUniqueOrThrow({ where: { id: bid } })).isOpenManual).toBe(
      true,
    );
  });

  it('edits hours, holidays, prep time and delivery settings within limits', async () => {
    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    const b = manager.browser;
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensAt: '12:00',
      closesAt: '23:30',
    }));
    const saved = (await b.put(`/merchant/branches/${bid}/hours`, { hours })).body.data;
    expect(saved.hours).toHaveLength(7);
    expect(
      (
        await b.put(`/merchant/branches/${bid}/hours`, {
          hours: [...hours, { weekday: 1, opensAt: '23:00', closesAt: '01:00' }],
        })
      ).status,
    ).toBe(400);

    const holiday = (
      await b.post(`/merchant/branches/${bid}/holidays`, {
        startsAt: todayAt('12:30').toISOString(),
        endsAt: todayAt('18:00').toISOString(),
        reason: 'Staff training',
      })
    ).body.data;
    expect((await b.get(`/merchant/branches/${bid}/status`)).body.data).toMatchObject({
      state: 'CLOSED',
      reason: 'HOLIDAY',
    });
    expect((await b.get(`/merchant/branches/${bid}/holidays`)).body.data).toEqual([
      expect.objectContaining({ id: holiday.id, reason: 'Staff training' }),
    ]);
    await b.delete(`/merchant/branches/${bid}/holidays/${holiday.id}`);
    expect((await b.get(`/merchant/branches/${bid}/status`)).body.data.state).toBe('OPEN');

    const rush = (
      await b.patch(`/merchant/branches/${bid}/prep-time`, {
        defaultPrepMinutes: 25,
        rush: { extraMinutes: 20, forMinutes: 60 },
      })
    ).body.data;
    expect(rush.rush).toMatchObject({ extraMinutes: 20 });
    expect(
      (
        await b.patch(`/merchant/branches/${bid}/prep-time`, {
          rush: { extraMinutes: 20, forMinutes: 180 },
        })
      ).status,
    ).toBe(400); // ≤ 2 h

    const bad = await b.patch(`/merchant/branches/${bid}`, {
      deliveryRadiusM: 14_000,
      packagingFeeMode: 'PER_ITEM',
      packagingFeeAmount: 2_000,
    });
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'deliveryRadiusM',
      'packagingFeeAmount',
    ]);
    const ok = await b.patch(`/merchant/branches/${bid}`, {
      deliveryRadiusM: 3_000,
      minOrderAmount: 19_900,
      packagingFeeMode: 'PER_ORDER',
      packagingFeeAmount: 2_000,
    });
    expect(ok.body.data).toMatchObject({
      deliveryRadiusM: 3_000,
      minOrderAmount: 19_900,
      packagingFeeAmount: 2_000,
    });
  });

  it('enforces roles: kitchen staff can read but not change status; strangers see nothing', async () => {
    const kitchen = await signInAs(ctx, SAFFRON_STAFF.kitchen); // Koramangala only, no branch:status
    const kora = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
    expect((await kitchen.browser.get(`/merchant/branches/${kora}/status`)).status).toBe(200);
    expect(
      (await kitchen.browser.post(`/merchant/branches/${kora}/pause`, { reason: 'OTHER' })).status,
    ).toBe(403);
    expect((await kitchen.browser.get(`/merchant/branches/${bid}/status`)).status).toBe(404); // not their branch
    expect((await kitchen.browser.get(`/merchant/restaurants/${rid}`)).status).toBe(403); // no restaurant:read

    const applicant = await signUpCustomer(ctx, { app: 'RESTAURANT' });
    expect((await applicant.browser.get(`/merchant/branches/${bid}/status`)).status).toBe(403); // onboarding scope
  });

  it('checks the go-live list before opening (BR-REST-006)', async () => {
    const owner = await signInAs(ctx, SAFFRON_STAFF.owner);
    // Seed restaurants have no verified bank account or logo yet.
    expect((await owner.browser.get(`/merchant/branches/${bid}/go-live`)).body.data).toMatchObject({
      ready: false,
      missing: [
        expect.objectContaining({ path: 'bank' }),
        expect.objectContaining({ path: 'logo' }),
      ],
    });
    await ctx.prisma.branch.update({ where: { id: bid }, data: { isOpenManual: false } });
    await ctx.prisma.branchOperatingHour.deleteMany({ where: { branchId: bid } });
    const refused = await owner.browser.post(`/merchant/branches/${bid}/open`);
    expect(refused.body.error.code).toBe('GO_LIVE_INCOMPLETE');
    expect(refused.body.error.details.map((d: { path: string }) => d.path)).toEqual([
      'hours',
      'bank',
      'logo',
    ]);
    expect((await ctx.prisma.branch.findUniqueOrThrow({ where: { id: bid } })).isOpenManual).toBe(
      false,
    );
  });
});

suite('restaurant profile (API-MER-008…014)', () => {
  it('shows masked details, edits non-legal fields and sends legal changes for review after re-auth', async () => {
    const owner = await signInAs(ctx, SAFFRON_STAFF.owner);
    const b = owner.browser;
    const profile = (await b.get(`/merchant/restaurants/${rid}`)).body.data;
    expect(profile).toMatchObject({ brandName: 'Saffron Handi Biryani', pendingChanges: [] });
    expect(
      (await b.patch(`/merchant/restaurants/${rid}`, { description: 'Dum biryani since 1998' }))
        .body.data.description,
    ).toBe('Dum biryani since 1998');
    expect(
      (await b.get(`/merchant/restaurants/${rid}/branches`)).body.data.map(
        (x: { name: string }) => x.name,
      ),
    ).toEqual(['Indiranagar', 'Koramangala']);

    const change = {
      type: 'BANK_ACCOUNT',
      values: { holderName: 'Saffron Foods', accountNumber: '998877665544', ifsc: 'ICIC0000123' },
    };
    expect(
      (await b.post(`/merchant/restaurants/${rid}/change-requests`, change)).body.error.code,
    ).toBe('AUTH_REAUTH_REQUIRED');
    await b.post('/auth/reauth', { password: 'kitchen pass phrase 42' });
    const created = await b.post(`/merchant/restaurants/${rid}/change-requests`, change);
    expect(created.status).toBe(201);
    expect(
      (await b.post(`/merchant/restaurants/${rid}/change-requests`, change)).body.error.code,
    ).toBe('CHANGE_REQUEST_PENDING');
    const list = (await b.get(`/merchant/restaurants/${rid}/change-requests`)).body.data;
    expect(list[0]).toEqual(expect.not.objectContaining({ values: expect.anything() }));
    const row = await ctx.prisma.restaurantChangeRequest.findUniqueOrThrow({
      where: { id: created.body.data.id },
    });
    expect(JSON.parse(ctx.container.fieldCipher.decrypt(row.payloadEncrypted))).toMatchObject({
      accountNumber: '998877665544',
    });

    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    expect(
      (await manager.browser.post(`/merchant/restaurants/${rid}/change-requests`, change)).status,
    ).toBe(403);
    await ctx.prisma.restaurantChangeRequest.deleteMany({ where: { restaurantId: rid } });
  });
});
