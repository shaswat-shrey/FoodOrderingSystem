import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  browser,
  createFixtureOrder,
  createOwnedRestaurant,
  createTestContext,
  integrationEnabled,
  parkActiveDeliveries,
  setPassword,
  signInAs,
  signUpApplicant,
  signUpCustomer,
  uploadFile,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let zoneId: string;
let cuisineId: string;
/** Restaurants this file approves; hidden again afterwards so other suites' listings stay stable. */
const created: string[] = [];

const STAFF = {
  superAdmin: '+919000000001',
  admin: '+919000000002',
  support: '+919000000003',
} as const;
const PASSWORD = 'admin console passphrase';
const KORAMANGALA = { lat: 12.9352, lng: 77.6245 };
const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
const image = () =>
  sharp({ create: { width: 400, height: 400, channels: 3, background: '#2a6' } })
    .png()
    .toBuffer();
const key = () => ({ 'Idempotency-Key': uuidv7() });

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  zoneId = (await ctx.prisma.zone.findFirstOrThrow({ where: { status: 'ACTIVE' } })).id;
  cuisineId = (await ctx.prisma.cuisine.findFirstOrThrow({ where: { isActive: true } })).id;
});
afterAll(async () => {
  if (!integrationEnabled) return;
  // Other files sign the same staff in at the same manual clock time: lift this file's OTP cooldown.
  await ctx.prisma.otpCode.deleteMany({
    where: { userId: { in: [...signedIn.values()].map((s) => s.userId) } },
  });
  await ctx.prisma.branch.updateMany({
    where: { restaurantId: { in: created } },
    data: { deletedAt: new Date() },
  });
  await ctx.prisma.restaurant.updateMany({
    where: { id: { in: created } },
    data: { status: 'DEACTIVATED' },
  });
  await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
});

const signedIn = new Map<string, { browser: ReturnType<typeof browser>; userId: string }>();

/**
 * Signs a seeded staff member into the admin app through the emailed second
 * factor (BR-AUTH-018), once per file: the OTP resend cooldown would refuse a
 * second code at the same (manual) clock time.
 */
async function staff(phone: string) {
  const known = signedIn.get(phone);
  if (known) return known;
  const user = await ctx.prisma.user.findFirstOrThrow({ where: { phone } });
  await setPassword(ctx.prisma, user.id, PASSWORD);
  const b = browser(ctx, 'ADMIN');
  const first = await b.post('/auth/login', { identifier: phone, password: PASSWORD });
  expect(first.body.data.mfaRequired).toBe(true);
  const code = ctx.messages.lastOtp(user.email!)!;
  const done = b.remember(
    await b.post('/auth/mfa/challenge', { mfaToken: first.body.data.mfaToken, code }),
  );
  expect(done.status).toBe(200);
  const result = { browser: b, userId: user.id };
  signedIn.set(phone, result);
  return result;
}

const audited = (action: string, targetId: string) =>
  ctx.prisma.auditLog.findFirst({
    where: { action, targetId },
    orderBy: { createdAt: 'desc' },
  });

suite('admin access (ADR-002, BR-ADMIN-002)', () => {
  it('needs the admin app, the platform permission, and a reason for ★ actions', async () => {
    const customer = await signUpCustomer(ctx);
    expect((await customer.browser.get('/admin/users')).status).toBe(403);

    const support = await staff(STAFF.support);
    const list = await support.browser.get('/admin/users', { q: customer.phone.slice(-8) });
    expect(list.status).toBe(200);
    expect(
      (await support.browser.post(`/admin/users/${customer.userId}/suspend`, { reason: 'Abuse' }))
        .body.error.code,
    ).toBe('FORBIDDEN');

    const admin = await staff(STAFF.admin);
    const noReason = await admin.browser.post(`/admin/users/${customer.userId}/suspend`, {});
    expect(noReason.status).toBe(400);
    const tooShort = await admin.browser.post(`/admin/users/${customer.userId}/suspend`, {
      reason: 'bad',
    });
    expect(tooShort.status).toBe(400);
    expect(
      (await admin.browser.post(`/admin/users/${admin.userId}/suspend`, { reason: 'Testing self' }))
        .body.error.code,
    ).toBe('FORBIDDEN');
    // commission:write is super-admin only.
    const r = await createOwnedRestaurant(ctx);
    created.push(r.restaurantId);
    expect(
      (
        await admin.browser.put(`/admin/restaurants/${r.restaurantId}/commission`, {
          rateBps: 1500,
          reason: 'Negotiated rate',
        })
      ).status,
    ).toBe(403);
  });
});

suite('users (API-ADM-010…017, 019, FR-ADMIN-010, FR-AUTH-040)', () => {
  it('searches with masked PII and reveals it only with an audited reason', async () => {
    const c = await signUpCustomer(ctx);
    const admin = await staff(STAFF.admin);
    const list = await admin.browser.get('/admin/users', {
      q: c.phone.slice(-8),
      role: 'CUSTOMER',
      pageSize: 5,
    });
    expect(list.body.meta.pagination).toMatchObject({ page: 1, pageSize: 5, total: 1 });
    expect(list.body.data[0]).toMatchObject({
      id: c.userId,
      phone: `+91XXXXXX${c.phone.slice(-4)}`,
      roles: ['CUSTOMER'],
    });
    expect(list.body.data[0].email).not.toBe(c.email);

    const detail = (await admin.browser.get(`/admin/users/${c.userId}`)).body.data;
    expect(detail).toMatchObject({
      status: 'ACTIVE',
      phone: `+91XXXXXX${c.phone.slice(-4)}`,
      flags: { codBlocked: false },
      wallet: { availableAmount: 0 },
      orders: { total: 0 },
    });
    expect(detail.activeSessions).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(detail)).not.toContain(c.phone);

    const support = await staff(STAFF.support);
    const revealed = await support.browser.post(`/admin/users/${c.userId}/pii-reveal`, {
      reason: 'Customer called about a refund',
    });
    expect(revealed.body.data).toMatchObject({ phone: c.phone, email: c.email });
    expect(await audited('admin.pii_revealed', c.userId)).toMatchObject({
      actorUserId: support.userId,
      reason: 'Customer called about a refund',
      sensitivity: 'HIGH',
    });

    const sessions = (await admin.browser.get(`/admin/users/${c.userId}/sessions`)).body.data;
    expect(sessions[0]).toMatchObject({ app: 'CUSTOMER' });
  });

  it('suspends (revoking every session), lifts it, forces logout and blocks COD', async () => {
    const c = await signUpCustomer(ctx);
    expect((await c.browser.get('/me')).status).toBe(200);
    const admin = await staff(STAFF.admin);
    const until = new Date(ctx.clock.now().getTime() + 7 * 86_400_000).toISOString();
    const res = await admin.browser.post(`/admin/users/${c.userId}/suspend`, {
      reason: 'Repeated abuse of refunds',
      until,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'SUSPENDED',
      suspension: { reason: 'Repeated abuse of refunds' },
      activeSessions: 0,
    });
    expect((await c.browser.get('/me')).body.error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
    expect(
      await ctx.prisma.userSession.count({ where: { userId: c.userId, status: 'ACTIVE' } }),
    ).toBe(0);
    const login = await browser(ctx).post('/auth/login', {
      identifier: c.phone,
      password: c.password,
    });
    expect(login.body.error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
    expect(
      (await admin.browser.post(`/admin/users/${c.userId}/suspend`, { reason: 'Again please' }))
        .body.error.code,
    ).toBe('ACCOUNT_STATE_CONFLICT');
    expect(await audited('admin.user_suspended', c.userId)).toMatchObject({
      sensitivity: 'HIGH',
      reason: 'Repeated abuse of refunds',
    });

    const lifted = await admin.browser.post(`/admin/users/${c.userId}/unsuspend`, {
      reason: 'Appeal accepted',
    });
    expect(lifted.body.data.status).toBe('ACTIVE');
    const again = browser(ctx);
    expect(
      again.remember(await again.post('/auth/login', { identifier: c.phone, password: c.password }))
        .status,
    ).toBe(200);

    const out = await admin.browser.post(`/admin/users/${c.userId}/logout-all`, {
      reason: 'Phone reported stolen',
    });
    expect(out.body.data.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await again.get('/me')).status).toBe(401);

    const blocked = await admin.browser.post(`/admin/users/${c.userId}/cod-block`, {
      blocked: true,
      reason: 'Refused three COD orders',
    });
    expect(blocked.body.data.codBlocked).toBe(true);
    expect(
      (await ctx.prisma.customerProfile.findUniqueOrThrow({ where: { userId: c.userId } }))
        .codBlocked,
    ).toBe(true);
  });

  it('credits and debits the wallet through the ledger, never below zero', async () => {
    const c = await signUpCustomer(ctx);
    const admin = await staff(STAFF.admin);
    const path = `/admin/users/${c.userId}/wallet-adjustments`;
    const headers = key();
    const credit = await admin.browser.post(
      path,
      { amount: 10_000, reason: 'Late delivery goodwill' },
      headers,
    );
    expect(credit.status).toBe(201);
    expect(credit.body.data.availableAmount).toBe(10_000);
    // A retry with the same key doesn't credit twice.
    const replay = await admin.browser.post(
      path,
      { amount: 10_000, reason: 'Late delivery goodwill' },
      headers,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await ctx.container.wallet.available(c.userId)).toBe(10_000);

    const debit = await admin.browser.post(
      path,
      { amount: -4_000, reason: 'Credited twice by mistake' },
      key(),
    );
    expect(debit.body.data.availableAmount).toBe(6_000);
    expect(
      (await admin.browser.post(path, { amount: -7_000, reason: 'Too much back' }, key())).body
        .error.code,
    ).toBe('INSUFFICIENT_WALLET_BALANCE');
    expect((await admin.browser.post(path, { amount: 0, reason: 'Nothing' }, key())).status).toBe(
      400,
    );
    expect(
      (await admin.browser.post(path, { amount: 2_000_000, reason: 'Way too much' }, key())).status,
    ).toBe(400);
    expect((await c.browser.get('/me/wallet')).body.data.availableAmount).toBe(6_000);
    expect(await audited('admin.wallet_adjusted', c.userId)).toMatchObject({
      sensitivity: 'HIGH',
      reason: 'Credited twice by mistake',
    });
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });
});

/** A complete restaurant application, ready to submit. */
async function restaurantApplication() {
  const a = await signUpApplicant(ctx);
  const b = a.browser;
  const id = (
    await b.post('/merchant/applications', {
      brandName: 'Admin Review Kitchen',
      legalName: 'Admin Review Kitchen LLP',
      entityType: 'LLP',
    })
  ).body.data.id as string;
  created.push(id);
  const logo = (await uploadFile(ctx, b, 'RESTAURANT', 'RESTAURANT_LOGO', await image(), 'l.png'))
    .body.data;
  const saved = await b.patch(`/merchant/applications/${id}`, {
    pan: 'abcpe1234k',
    fssaiNumber: String(Date.now()).padStart(14, '6').slice(-14),
    fssaiExpiresOn: `${new Date().getFullYear() + 2}-03-31`,
    cuisineIds: [cuisineId],
    logoFileId: logo.id,
    branch: {
      name: 'Koramangala',
      line1: '7, 6th Block',
      area: 'Koramangala',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560095',
      location: KORAMANGALA,
      deliveryRadiusM: 4000,
      defaultPrepMinutes: 20,
      hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        opensAt: '10:00',
        closesAt: '23:00',
      })),
    },
    bank: { holderName: 'Admin Review LLP', accountNumber: '001234567890', ifsc: 'HDFC0001234' },
  });
  expect(saved.status).toBe(200);
  for (const type of ['FSSAI', 'PAN', 'BANK_PROOF']) {
    const f = (await uploadFile(ctx, b, 'RESTAURANT', 'RESTAURANT_DOCUMENT', pdf, `${type}.pdf`))
      .body.data;
    await b.post(`/merchant/applications/${id}/documents`, { type, fileId: f.id });
  }
  expect((await b.post(`/merchant/applications/${id}/submit`, { declareNoGst: true })).status).toBe(
    200,
  );
  return { ...a, id };
}

suite('restaurant applications and documents (API-ADM-020…025, 040)', () => {
  it('queues, claims, asks for changes, approves with a reason, and audits document views', async () => {
    const a = await restaurantApplication();
    const admin = await staff(STAFF.admin);
    const queue = await admin.browser.get('/admin/restaurant-applications', { pageSize: 100 });
    expect(queue.body.data.map((r: { id: string }) => r.id)).toContain(a.id);

    const view = (await admin.browser.get(`/admin/restaurant-applications/${a.id}`)).body.data;
    expect(view).toMatchObject({
      status: 'SUBMITTED',
      panMasked: 'XXXXXX234K',
      bank: { accountMasked: 'XXXXXX7890' },
      missing: [],
      branch: { status: 'PENDING_APPROVAL' },
    });
    expect(JSON.stringify(view)).not.toContain('001234567890');
    expect(view.documents).toHaveLength(3);

    const doc = view.documents[0] as { id: string };
    const support = await staff(STAFF.support);
    expect((await support.browser.get(`/admin/documents/${doc.id}/url`)).status).toBe(403);
    const signed = await admin.browser.get(`/admin/documents/${doc.id}/url`);
    expect(signed.status).toBe(200);
    expect(signed.body.data).toMatchObject({ documentId: doc.id, url: expect.any(String) });
    expect(new Date(signed.body.data.expiresAt).getTime()).toBeLessThanOrEqual(
      ctx.clock.now().getTime() + 300_000,
    );
    expect(await audited('file.signed_url', doc.id)).toMatchObject({
      actorUserId: admin.userId,
      targetType: 'restaurant_document',
      sensitivity: 'HIGH',
    });

    const claimed = await admin.browser.post(`/admin/restaurant-applications/${a.id}/start-review`);
    expect(claimed.body.data.status).toBe('UNDER_REVIEW');
    expect(
      (await admin.browser.post(`/admin/restaurant-applications/${a.id}/start-review`)).body.error
        .code,
    ).toBe('APPLICATION_STATE_CONFLICT');

    const changes = await admin.browser.post(
      `/admin/restaurant-applications/${a.id}/request-changes`,
      { comments: { 'documents.PAN': 'The PAN copy is blurry' } },
    );
    expect(changes.body.data.status).toBe('CHANGES_REQUESTED');
    expect((await a.browser.get(`/merchant/applications/${a.id}`)).body.data.review).toMatchObject({
      comments: { 'documents.PAN': 'The PAN copy is blurry' },
    });
    await a.browser.post(`/merchant/applications/${a.id}/submit`, { declareNoGst: true });

    expect(
      (await admin.browser.post(`/admin/restaurant-applications/${a.id}/approve`, {})).status,
    ).toBe(400);
    const approved = await admin.browser.post(`/admin/restaurant-applications/${a.id}/approve`, {
      reason: 'Documents verified against FSSAI portal',
    });
    expect(approved.body.data).toMatchObject({ status: 'APPROVED' });
    expect(await audited('restaurant.application_approved', a.id)).toMatchObject({
      sensitivity: 'HIGH',
      reason: 'Documents verified against FSSAI portal',
    });
    const roles = await ctx.prisma.userRole.findMany({
      where: { userId: a.userId },
      include: { role: true },
    });
    expect(roles.map((r) => r.role.key)).toContain('RESTAURANT_OWNER');
  });
});

suite('restaurants, branches and change requests (API-ADM-026…038)', () => {
  it('approves a branch, and suspending the branch or restaurant stops orders and staff access', async () => {
    const r = await createOwnedRestaurant(ctx);
    created.push(r.restaurantId);
    const admin = await staff(STAFF.admin);
    const status = () => ctx.container.branchOps.status(r.branchId);

    const approved = await admin.browser.post(`/admin/branches/${r.branchId}/approve`, {
      reason: 'Outlet inspected in person',
    });
    expect(approved.body.data.status).toBe('ACTIVE');
    expect((await status()).reason).not.toBe('NOT_LISTED');

    expect(
      (await admin.browser.post(`/admin/branches/${r.branchId}/suspend`, { reason: 'Hygiene' }))
        .body.data.status,
    ).toBe('SUSPENDED');
    expect(await status()).toMatchObject({ acceptingOrders: false, reason: 'NOT_LISTED' });
    expect(
      await ctx.prisma.branchStatusEvent.count({
        where: { branchId: r.branchId, event: 'SUSPENDED' },
      }),
    ).toBe(1);
    await admin.browser.post(`/admin/branches/${r.branchId}/unsuspend`, { reason: 'Fixed now' });
    expect((await status()).reason).not.toBe('NOT_LISTED');

    expect((await r.browser.get(`/merchant/restaurants/${r.restaurantId}`)).status).toBe(200);
    const suspended = await admin.browser.post(`/admin/restaurants/${r.restaurantId}/suspend`, {
      reason: 'FSSAI licence under investigation',
    });
    expect(suspended.body.data).toMatchObject({ status: 'SUSPENDED' });
    expect(await status()).toMatchObject({ acceptingOrders: false, reason: 'NOT_LISTED' });
    expect((await r.browser.get(`/merchant/restaurants/${r.restaurantId}`)).status).not.toBe(200);
    expect(await audited('admin.restaurant_suspended', r.restaurantId)).toMatchObject({
      sensitivity: 'HIGH',
    });
    await admin.browser.post(`/admin/restaurants/${r.restaurantId}/unsuspend`, {
      reason: 'Investigation closed',
    });
    expect((await r.browser.get(`/merchant/restaurants/${r.restaurantId}`)).status).toBe(200);

    const listed = await admin.browser.get('/admin/restaurants', {
      q: 'Test Kitchen',
      zone: zoneId,
      pageSize: 100,
    });
    expect(listed.body.data.map((x: { id: string }) => x.id)).toContain(r.restaurantId);
    const patched = await admin.browser.patch(`/admin/restaurants/${r.restaurantId}`, {
      description: 'Updated on the owner’s request',
      reason: 'Owner asked by phone',
    });
    expect(patched.body.data.description).toBe('Updated on the owner’s request');
    expect(
      (await admin.browser.patch(`/admin/restaurants/${r.restaurantId}`, { reason: 'Nothing' }))
        .status,
    ).toBe(400);

    const cod = await admin.browser.put(`/admin/restaurants/${r.restaurantId}/cod`, {
      enabled: false,
      reason: 'Too many refused COD orders',
    });
    expect(cod.body.data.codEnabled).toBe(false);
    const sa = await staff(STAFF.superAdmin);
    const commission = await sa.browser.put(`/admin/restaurants/${r.restaurantId}/commission`, {
      rateBps: 1_500,
      reason: 'Negotiated launch rate',
    });
    expect(commission.status).toBe(200);
    expect(
      await ctx.container.pricingConfig.commissionRateBps(
        r.restaurantId,
        new Date(ctx.clock.now().getTime() + 1_000),
      ),
    ).toMatchObject({ rateBps: 1_500, source: 'OVERRIDE' });
    const view = (await admin.browser.get(`/admin/restaurants/${r.restaurantId}`)).body.data;
    expect(view).toMatchObject({
      status: 'ACTIVE',
      codEnabled: false,
      branches: [expect.objectContaining({ id: r.branchId, status: 'ACTIVE' })],
      members: [expect.objectContaining({ role: 'OWNER' })],
    });
  });

  it('approves legal and bank changes by applying them, and rejects others', async () => {
    const r = await createOwnedRestaurant(ctx);
    created.push(r.restaurantId);
    const profile = ctx.container.restaurantProfile;
    const legal = await profile.requestChange(r.userId, r.restaurantId, 'LEGAL_NAME', {
      legalName: 'Renamed Kitchen Pvt Ltd',
    });
    const bank = await profile.requestChange(r.userId, r.restaurantId, 'BANK_ACCOUNT', {
      holderName: 'Renamed Kitchen',
      accountNumber: '998877665544',
      ifsc: 'ICIC0000123',
    });
    const gst = await profile.requestChange(r.userId, r.restaurantId, 'GSTIN', {
      gstin: '29ABCDE1234F1Z5',
    });
    const admin = await staff(STAFF.admin);
    const queue = (await admin.browser.get('/admin/change-requests', { pageSize: 100 })).body.data;
    const bankRow = queue.find((c: { id: string }) => c.id === bank.id);
    expect(bankRow.requested).toEqual({
      holderName: 'Renamed Kitchen',
      accountMasked: 'XXXXXX5544',
      ifsc: 'ICIC0000123',
    });
    expect(JSON.stringify(queue)).not.toContain('998877665544');

    expect(
      (await admin.browser.post(`/admin/change-requests/${legal.id}/approve`, {})).status,
    ).toBe(400);
    await admin.browser.post(`/admin/change-requests/${legal.id}/approve`, {
      reason: 'Matches the new incorporation certificate',
    });
    await admin.browser.post(`/admin/change-requests/${bank.id}/approve`, {
      reason: 'Cancelled cheque verified',
    });
    const rejected = await admin.browser.post(`/admin/change-requests/${gst.id}/reject`, {
      reason: 'GSTIN does not match the PAN',
    });
    expect(rejected.body.data.status).toBe('REJECTED');
    expect(
      (
        await admin.browser.post(`/admin/change-requests/${gst.id}/approve`, {
          reason: 'Changed my mind',
        })
      ).body.error.code,
    ).toBe('APPLICATION_STATE_CONFLICT');

    const after = await ctx.prisma.restaurant.findUniqueOrThrow({
      where: { id: r.restaurantId },
      include: { bankAccounts: true },
    });
    expect(after.legalName).toBe('Renamed Kitchen Pvt Ltd');
    expect(after.gstin).toBeNull();
    const verified = after.bankAccounts.filter((b) => b.status === 'VERIFIED');
    expect(verified).toHaveLength(1);
    expect(verified[0]!.accountLast4).toBe('5544');
    expect(ctx.container.fieldCipher.decrypt(verified[0]!.accountNumberEncrypted)).toBe(
      '998877665544',
    );
    expect(await audited('admin.change_request_approved', r.restaurantId)).toMatchObject({
      sensitivity: 'HIGH',
    });
  });
});

/** A complete partner application with a bicycle, submitted. */
async function partnerApplication() {
  const a = await signUpCustomer(ctx, { app: 'DELIVERY' });
  const b = a.browser;
  await b.post('/partner/applications');
  const pic = (await uploadFile(ctx, b, 'DELIVERY', 'PARTNER_PHOTO', await image(), 'me.png')).body
    .data;
  await b.patch('/partner/applications/me', {
    dateOfBirth: '1995-06-01',
    homeZoneId: zoneId,
    photoFileId: pic.id,
    pan: 'abcpk1234l',
    aadhaarLast4: '4321',
    emergencyContact: { name: 'Meena', relation: 'Sister', phone: '+919811112222' },
    vehicle: { type: 'BICYCLE' },
    bank: { holderName: 'Admin Rider', accountNumber: '50100012345678', ifsc: 'HDFC0001234' },
  });
  for (const type of ['PAN', 'ID_PROOF', 'BANK_PROOF']) {
    const f = (await uploadFile(ctx, b, 'DELIVERY', 'PARTNER_DOCUMENT', pdf, `${type}.pdf`)).body
      .data;
    await b.post('/partner/applications/me/documents', { type, fileId: f.id });
  }
  expect((await b.post('/partner/applications/me/submit')).body.data.status).toBe('SUBMITTED');
  const row = await ctx.prisma.deliveryPartner.findUniqueOrThrow({ where: { userId: a.userId } });
  return { ...a, partnerId: row.id };
}

suite('partners (API-ADM-041…054, FR-ADMIN-030/031, FR-EARN-004/005)', () => {
  let rider: Awaited<ReturnType<typeof partnerApplication>>;

  it('reviews an application: changes requested, then approved; verifies vehicles', async () => {
    await parkActiveDeliveries(ctx);
    rider = await partnerApplication();
    const admin = await staff(STAFF.admin);
    const queue = await admin.browser.get('/admin/partner-applications', {
      zone: zoneId,
      pageSize: 100,
    });
    expect(queue.body.data.map((p: { id: string }) => p.id)).toContain(rider.partnerId);
    const view = (await admin.browser.get(`/admin/partner-applications/${rider.partnerId}`)).body
      .data;
    expect(view).toMatchObject({
      status: 'SUBMITTED',
      panMasked: 'XXXXXX234L',
      aadhaarMasked: 'XXXX XXXX 4321',
      bank: { accountMasked: 'XXXXXX5678' },
    });

    const changes = await admin.browser.post(
      `/admin/partner-applications/${rider.partnerId}/request-changes`,
      { reason: 'Please upload a clearer ID', documentNotes: { ID_PROOF: 'Photo is cut off' } },
    );
    expect(changes.body.data.status).toBe('CHANGES_REQUESTED');
    const mine = (await rider.browser.get('/partner/applications/me')).body.data;
    expect(mine.changesRequested).toBe('Please upload a clearer ID');
    expect(mine.documents.find((d: { type: string }) => d.type === 'ID_PROOF').reviewerNote).toBe(
      'Photo is cut off',
    );
    await rider.browser.post('/partner/applications/me/submit');

    const support = await staff(STAFF.support);
    expect(
      (
        await support.browser.post(`/admin/partner-applications/${rider.partnerId}/approve`, {
          reason: 'All documents verified',
        })
      ).status,
    ).toBe(403);
    const approved = await admin.browser.post(
      `/admin/partner-applications/${rider.partnerId}/approve`,
      { reason: 'All documents verified' },
    );
    expect(approved.body.data.status).toBe('APPROVED');
    expect(await audited('partner.application_decided', rider.partnerId)).toMatchObject({
      sensitivity: 'HIGH',
      reason: 'All documents verified',
    });

    const signedIn = await signInAs(ctx, rider.phone, 'DELIVERY');
    rider = { ...rider, browser: signedIn.browser };
    await rider.browser.post('/partner/me/guidelines/ack', { version: '1.0' });
    const added = await rider.browser.post('/partner/me/vehicles', {
      type: 'SCOOTER',
      registrationNumber: 'KA05MN4321',
    });
    const scooter = added.body.data.vehicles.find((v: { type: string }) => v.type === 'SCOOTER');
    expect(scooter.status).toBe('PENDING');
    const verified = await admin.browser.post(`/admin/vehicles/${scooter.id}/verify`, {
      decision: 'VERIFIED',
      reason: 'RC checked on Vahan',
    });
    expect(verified.body.data.status).toBe('VERIFIED');
  });

  it('suspends (forcing the partner offline), unsuspends and forces offline', async () => {
    const admin = await staff(STAFF.admin);
    const fix = () => ({
      lat: 12.9355,
      lng: 77.6245,
      accuracyM: 10,
      recordedAt: ctx.clock.now().toISOString(),
    });
    const online = await rider.browser.post('/partner/me/online', fix(), key());
    expect(online.status).toBe(200);
    const listed = await admin.browser.get('/admin/partners', { online: 'true', pageSize: 100 });
    expect(listed.body.data.map((p: { id: string }) => p.id)).toContain(rider.partnerId);

    const suspended = await admin.browser.post(`/admin/partners/${rider.partnerId}/suspend`, {
      reason: 'Customer safety complaint',
    });
    expect(suspended.body.data).toMatchObject({ status: 'SUSPENDED', offline: true });
    expect((await ctx.container.presence.get(rider.partnerId))?.state).toBe('OFFLINE');
    expect(
      await ctx.prisma.partnerOnlineSession.findFirst({
        where: { partnerId: rider.partnerId },
        orderBy: { startedAt: 'desc' },
      }),
    ).toMatchObject({ endReason: 'SUSPENDED' });
    expect((await rider.browser.post('/partner/me/online', fix(), key())).body.error.code).toBe(
      'PARTNER_CANNOT_GO_ONLINE',
    );

    await admin.browser.post(`/admin/partners/${rider.partnerId}/unsuspend`, {
      reason: 'Complaint not upheld',
    });
    expect((await rider.browser.post('/partner/me/online', fix(), key())).status).toBe(200);
    const forced = await admin.browser.post(`/admin/partners/${rider.partnerId}/force-offline`, {
      reason: 'Stuck online after app crash',
    });
    expect(forced.body.data.offline).toBe(true);
    expect(
      await ctx.prisma.partnerOnlineSession.findFirst({
        where: { partnerId: rider.partnerId },
        orderBy: { startedAt: 'desc' },
      }),
    ).toMatchObject({ endReason: 'ADMIN_FORCED' });
    const detail = (await admin.browser.get(`/admin/partners/${rider.partnerId}`)).body.data;
    expect(detail).toMatchObject({
      accountStatus: 'ACTIVE',
      presence: { state: 'OFFLINE' },
      cashInHand: 0,
    });
  });

  it('records cash deposits and earnings adjustments in the ledger and the partner’s statement', async () => {
    const admin = await staff(STAFF.admin);
    // Cash collected on COD orders (fixture posting).
    await ctx.prisma.$transaction((tx) =>
      ctx.container.ledger.post(tx, {
        type: 'COD_COLLECTION',
        referenceType: 'test',
        referenceId: uuidv7(),
        description: 'Cash collected (fixture)',
        entries: [
          {
            ownerType: 'PARTNER',
            ownerId: rider.partnerId,
            type: 'PARTNER_CASH_IN_HAND',
            amount: 50_000,
          },
          { ownerType: 'PLATFORM', ownerId: null, type: 'CASH_CLEARING', amount: -50_000 },
        ],
      }),
    );
    const path = `/admin/partners/${rider.partnerId}/cash-deposits`;
    expect(
      (
        await admin.browser.post(
          path,
          { amount: 60_000, method: 'HUB', reason: 'Hub deposit' },
          key(),
        )
      ).body.error.details[0].code,
    ).toBe('EXCEEDS_CASH_IN_HAND');
    const dep = await admin.browser.post(
      path,
      { amount: 30_000, method: 'UPI', reference: 'UPI-778899', reason: 'UPI to platform' },
      key(),
    );
    expect(dep.status).toBe(201);
    expect(dep.body.data.cashInHand).toBe(20_000);
    const cash = (await rider.browser.get('/partner/me/cash')).body.data;
    expect(cash.balance).toBe(20_000);
    const moves = (await rider.browser.get('/partner/me/cash/transactions')).body.data;
    expect(moves[0]).toMatchObject({ type: 'CASH_DEPOSIT', amount: -30_000 });

    const adj = await admin.browser.post(
      `/admin/partners/${rider.partnerId}/earning-adjustments`,
      { amount: 15_000, note: 'Penalty reversed', reason: 'Wrongly penalised for late delivery' },
      key(),
    );
    expect(adj.body.data.earningsBalance).toBe(15_000);
    const entries = (await rider.browser.get('/partner/me/earnings')).body.data;
    expect(entries[0]).toMatchObject({
      type: 'ADJUSTMENT',
      amount: 15_000,
      description: 'Penalty reversed',
    });
    const day = (await rider.browser.get('/partner/me/earnings/summary?period=day')).body.data;
    expect(day.breakdown.adjustments).toBe(15_000);
    expect(await audited('admin.partner_earnings_adjusted', rider.partnerId)).toMatchObject({
      sensitivity: 'HIGH',
      reason: 'Wrongly penalised for late delivery',
    });
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('shows a delivery’s location trail and audits each view', async () => {
    const r = await createOwnedRestaurant(ctx);
    created.push(r.restaurantId);
    const customer = await signUpCustomer(ctx);
    const order = await createFixtureOrder(ctx, {
      userId: customer.userId,
      branchId: r.branchId,
      status: 'DELIVERED',
    });
    const delivery = await ctx.prisma.delivery.create({
      data: {
        orderId: order.orderId,
        branchId: r.branchId,
        partnerId: rider.partnerId,
        status: 'DELIVERED',
      },
    });
    for (const [i, lat] of [12.93, 12.931, 12.932].entries())
      await ctx.prisma.$executeRaw`
        INSERT INTO delivery_locations (id, delivery_id, partner_id, location, accuracy_m, recorded_at)
        VALUES (${uuidv7()}::uuid, ${delivery.id}::uuid, ${rider.partnerId}::uuid,
          ST_SetSRID(ST_MakePoint(77.62, ${lat}), 4326)::geography, 8, ${new Date(Date.now() + i * 1000)})`;
    const support = await staff(STAFF.support);
    const trailPath = `/admin/partners/${rider.partnerId}/location-trail`;
    expect((await support.browser.get(trailPath, { deliveryId: delivery.id })).status).toBe(403);
    const admin = await staff(STAFF.admin);
    const trail = await admin.browser.get(trailPath, { deliveryId: delivery.id });
    expect(trail.body.data.points).toHaveLength(3);
    expect(trail.body.data.points[0]).toMatchObject({ lat: 12.93, lng: 77.62, accuracyM: 8 });
    expect(await audited('admin.partner_location_viewed', rider.partnerId)).toMatchObject({
      actorUserId: admin.userId,
      sensitivity: 'HIGH',
    });
    expect((await admin.browser.get(trailPath, { deliveryId: uuidv7() })).status).toBe(404);
  });
});
