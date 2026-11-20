import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { gstinCheckChar } from '@fos/validation';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  createTestContext,
  integrationEnabled,
  signUpApplicant,
  uploadFile,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let reviewer: string;
let cuisineId: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  reviewer = (await ctx.prisma.user.findFirstOrThrow({ where: { email: 'admin@example.com' } })).id;
  cuisineId = (await ctx.prisma.cuisine.findFirstOrThrow({ where: { isActive: true } })).id;
});
afterAll(async () => {
  if (!integrationEnabled) return;
  // Approved test restaurants would otherwise appear in other suites' listings.
  const created = await ctx.prisma.restaurant.findMany({
    where: { brandName: 'Andhra Ruchulu' },
    select: { id: true },
  });
  const ids = created.map((r) => r.id);
  await ctx.prisma.branch.updateMany({
    where: { restaurantId: { in: ids } },
    data: { deletedAt: new Date() },
  });
  await ctx.prisma.restaurant.updateMany({
    where: { id: { in: ids } },
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

const fssai = () => String(Date.now()).padStart(14, '7').slice(-14);
const KORAMANGALA = { lat: 12.9352, lng: 77.6245 };
const JAYANAGAR = { lat: 12.925, lng: 77.5838 }; // outside every zone
const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
const png = () =>
  sharp({ create: { width: 400, height: 400, channels: 3, background: '#2a6' } })
    .png()
    .toBuffer();

const details = (overrides: Record<string, unknown> = {}) => ({
  pan: 'abcpe1234k',
  fssaiNumber: fssai(),
  fssaiExpiresOn: `${new Date().getFullYear() + 2}-03-31`,
  description: 'Home-style Andhra meals',
  cuisineIds: [cuisineId],
  branch: {
    name: 'Koramangala',
    line1: '12, 5th Block',
    area: 'Koramangala',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560095',
    location: KORAMANGALA,
    deliveryRadiusM: 4000,
    defaultPrepMinutes: 20,
    priceForTwo: 40_000,
    hours: [1, 2, 3, 4, 5].flatMap((weekday) => [
      { weekday, opensAt: '11:00', closesAt: '15:00' },
      { weekday, opensAt: '19:00', closesAt: '00:30' },
    ]),
  },
  bank: { holderName: 'Andhra Ruchulu LLP', accountNumber: '001234567890', ifsc: 'hdfc0001234' },
  ...overrides,
});

async function completeApplication() {
  const a = await signUpApplicant(ctx);
  const b = a.browser;
  const started = await b.post('/merchant/applications', {
    brandName: 'Andhra Ruchulu',
    legalName: 'Andhra Ruchulu LLP',
    entityType: 'LLP',
  });
  expect(started.status).toBe(201);
  const id = started.body.data.id as string;
  const up = await uploadFile(ctx, b, 'RESTAURANT', 'RESTAURANT_LOGO', await png(), 'logo.png');
  const logo = up.body.data;
  expect(
    (await b.patch(`/merchant/applications/${id}`, { ...details(), logoFileId: logo.id })).status,
  ).toBe(200);
  for (const type of ['FSSAI', 'PAN', 'BANK_PROOF']) {
    const f = (await uploadFile(ctx, b, 'RESTAURANT', 'RESTAURANT_DOCUMENT', pdf, `${type}.pdf`))
      .body.data;
    expect(
      (await b.post(`/merchant/applications/${id}/documents`, { type, fileId: f.id })).status,
    ).toBe(201);
  }
  return { ...a, id };
}

suite('restaurant applications (API-MER-001…007, FR-REST-001…005)', () => {
  it('saves progress, lists what is missing, and keeps sensitive numbers encrypted', async () => {
    const a = await signUpApplicant(ctx);
    const b = a.browser;
    const me = (await b.get('/merchant/me')).body.data;
    expect(me).toMatchObject({ scope: 'ONBOARDING', restaurants: [], applications: [] });

    const id = (
      await b.post('/merchant/applications', {
        brandName: 'Andhra Ruchulu',
        legalName: 'Andhra Ruchulu LLP',
        entityType: 'LLP',
      })
    ).body.data.id;
    expect(
      (
        await b.post('/merchant/applications', {
          brandName: 'Second',
          legalName: 'Second Pvt Ltd',
          entityType: 'OTHER',
        })
      ).body.error.code,
    ).toBe('APPLICATION_STATE_CONFLICT');

    const early = await b.post(`/merchant/applications/${id}/submit`, {});
    expect(early.body.error.code).toBe('ONBOARDING_INCOMPLETE');
    expect(early.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['pan', 'branch', 'bank', 'logoFileId', 'documents.FSSAI']),
    );

    // Formats are checked (FR-REST-001 step 5).
    const bad = await b.patch(`/merchant/applications/${id}`, { gstin: '29ABCDE1234F1ZZ' });
    expect(bad.status).toBe(400);
    const body14 = '29ABCPE1234K1Z';
    expect(
      (await b.patch(`/merchant/applications/${id}`, { gstin: body14 + gstinCheckChar(body14) }))
        .status,
    ).toBe(200);
    // A pin outside our delivery zones can't be listed.
    const outside = await b.patch(`/merchant/applications/${id}`, {
      branch: { ...details().branch, location: JAYANAGAR },
    });
    expect(outside.body.error.code).toBe('ADDRESS_NOT_SERVICEABLE');
    const overlap = await b.patch(`/merchant/applications/${id}`, {
      branch: {
        ...details().branch,
        hours: [
          { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
          { weekday: 1, opensAt: '14:00', closesAt: '16:00' },
        ],
      },
    });
    expect(overlap.status).toBe(400);

    const saved = (await b.patch(`/merchant/applications/${id}`, details())).body.data;
    expect(saved).toMatchObject({
      status: 'DRAFT',
      panMasked: 'XXXXXX234K',
      bank: { accountMasked: 'XXXXXX7890', ifsc: 'HDFC0001234', status: 'PENDING_VERIFICATION' },
      branch: {
        area: 'Koramangala',
        status: 'PENDING_APPROVAL',
        hours: expect.arrayContaining([{ weekday: 1, opensAt: '19:00', closesAt: '00:30' }]),
      },
    });
    expect(saved.branch.location.lat).toBeCloseTo(KORAMANGALA.lat, 5);
    const row = await ctx.prisma.restaurant.findUniqueOrThrow({ where: { id } });
    expect(Buffer.from(row.panEncrypted!).toString('latin1')).not.toContain('ABCPE1234K');
    expect(ctx.container.fieldCipher.decrypt(row.panEncrypted!)).toBe('ABCPE1234K');
    const bank = await ctx.prisma.restaurantBankAccount.findFirstOrThrow({
      where: { restaurantId: id },
    });
    expect(ctx.container.fieldCipher.decrypt(bank.accountNumberEncrypted)).toBe('001234567890');

    // Not a member of anything yet: no merchant powers.
    expect((await b.get('/merchant/me')).body.data.restaurants).toEqual([]);
  });

  it('submits, takes change requests, and on approval makes the owner a member', async () => {
    const a = await completeApplication();
    const b = a.browser;
    // GSTIN absent: needs the no-GST declaration (BR-REST-005).
    const noDecl = await b.post(`/merchant/applications/${a.id}/submit`, {});
    expect(noDecl.body.error.details).toEqual([expect.objectContaining({ path: 'declareNoGst' })]);
    const submitted = await b.post(`/merchant/applications/${a.id}/submit`, { declareNoGst: true });
    expect(submitted.body.data).toMatchObject({
      status: 'SUBMITTED',
      editable: false,
      submissionCount: 1,
    });
    expect(
      (await b.patch(`/merchant/applications/${a.id}`, { description: 'x' })).body.error.code,
    ).toBe('APPLICATION_STATE_CONFLICT');
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { aggregateId: a.id, eventType: 'restaurant.application_submitted' },
      }),
    ).toBe(1);

    await ctx.container.onboarding.decide(reviewer, a.id, {
      decision: 'CHANGES_REQUESTED',
      comments: { 'documents.PAN': 'The PAN photo is blurry' },
    });
    const changes = (await b.get(`/merchant/applications/${a.id}`)).body.data;
    expect(changes).toMatchObject({
      status: 'CHANGES_REQUESTED',
      editable: true,
      review: {
        decision: 'CHANGES_REQUESTED',
        comments: { 'documents.PAN': 'The PAN photo is blurry' },
      },
    });
    const pan = (await uploadFile(ctx, b, 'RESTAURANT', 'RESTAURANT_DOCUMENT', pdf, 'pan2.pdf'))
      .body.data;
    await b.post(`/merchant/applications/${a.id}/documents`, { type: 'PAN', fileId: pan.id });
    expect(
      (await b.get(`/merchant/applications/${a.id}`)).body.data.documents.filter(
        (d: { type: string }) => d.type === 'PAN',
      ),
    ).toHaveLength(1);
    await b.post(`/merchant/applications/${a.id}/submit`, { declareNoGst: true });

    await ctx.container.onboarding.decide(reviewer, a.id, { decision: 'APPROVED' });
    const restaurant = await ctx.prisma.restaurant.findUniqueOrThrow({
      where: { id: a.id },
      include: { branches: true, bankAccounts: true, documents: true },
    });
    expect(restaurant).toMatchObject({ onboardingStatus: 'APPROVED', slug: 'andhra-ruchulu' });
    expect(restaurant.branches[0]).toMatchObject({ status: 'ACTIVE', isOpenManual: false });
    expect(restaurant.bankAccounts.find((x) => x.status === 'VERIFIED')).toBeTruthy();
    expect(restaurant.documents.every((d) => d.status === 'VERIFIED')).toBe(true);

    const me = (await b.get('/merchant/me')).body.data;
    expect(me.restaurants).toEqual([
      expect.objectContaining({
        id: a.id,
        role: 'OWNER',
        permissions: expect.arrayContaining(['rest.menu:write']),
        branches: [expect.objectContaining({ name: 'Koramangala' })],
      }),
    ]);
  });

  it('makes a rejected applicant wait 30 days (BR-REST-007)', async () => {
    const a = await completeApplication();
    await a.browser.post(`/merchant/applications/${a.id}/submit`, { declareNoGst: true });
    await ctx.container.onboarding.decide(reviewer, a.id, {
      decision: 'REJECTED',
      reason: 'FSSAI licence is for a different address',
    });
    expect((await a.browser.get(`/merchant/applications/${a.id}`)).body.data).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'FSSAI licence is for a different address',
    });
    const again = await a.browser.post('/merchant/applications', {
      brandName: 'Andhra Ruchulu',
      legalName: 'Andhra Ruchulu LLP',
      entityType: 'LLP',
    });
    expect(again.body.error.code).toBe('REAPPLY_TOO_SOON');
    expect((await a.browser.get('/merchant/me')).body.data.applications).toEqual([
      expect.objectContaining({ id: a.id, onboardingStatus: 'REJECTED' }),
    ]);
  });

  it('keeps other people out of an application', async () => {
    const a = await completeApplication();
    const other = await signUpApplicant(ctx);
    expect((await other.browser.get(`/merchant/applications/${a.id}`)).status).toBe(404);
    expect(
      (await other.browser.patch(`/merchant/applications/${a.id}`, { description: 'mine' })).status,
    ).toBe(404);
  });
});
