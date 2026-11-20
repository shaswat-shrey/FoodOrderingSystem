import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import { ageOn } from '../src/modules/partners';
import {
  createTestContext,
  integrationEnabled,
  signUpCustomer,
  uploadFile,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let zoneId: string;
let reviewer: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  zoneId = (await ctx.prisma.zone.findFirstOrThrow({ where: { status: 'ACTIVE' } })).id;
  reviewer = (await ctx.prisma.user.findFirstOrThrow({ where: { email: 'admin@example.com' } })).id;
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

const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
const photo = () =>
  sharp({ create: { width: 300, height: 300, channels: 3, background: '#888' } })
    .jpeg()
    .toBuffer();

async function application(
  vehicle: { type: string; registrationNumber?: string },
  dob = '1996-04-12',
) {
  const a = await signUpCustomer(ctx, { app: 'DELIVERY' });
  const b = a.browser;
  expect((await b.post('/partner/applications')).status).toBe(201);
  const zones = (await b.get('/partner/zones')).body.data as { id: string }[];
  expect(zones.map((z) => z.id)).toContain(zoneId);
  const pic = (await uploadFile(ctx, b, 'DELIVERY', 'PARTNER_PHOTO', await photo(), 'me.jpg')).body
    .data;
  const saved = await b.patch('/partner/applications/me', {
    dateOfBirth: dob,
    homeZoneId: zoneId,
    photoFileId: pic.id,
    pan: 'abcpk1234l',
    aadhaarLast4: '4321',
    emergencyContact: { name: 'Meena', relation: 'Sister', phone: '+919811112222' },
    vehicle,
    bank: { holderName: 'Ravi K', accountNumber: '50100012345678', ifsc: 'HDFC0001234' },
  });
  expect(saved.status).toBe(200);
  for (const type of ['PAN', 'ID_PROOF', 'BANK_PROOF']) {
    const f = (await uploadFile(ctx, b, 'DELIVERY', 'PARTNER_DOCUMENT', pdf, `${type}.pdf`)).body
      .data;
    expect(
      (await b.post('/partner/applications/me/documents', { type, fileId: f.id })).status,
    ).toBe(201);
  }
  return a;
}

suite('partner applications (API-DP-001…013, FR-DP-001…007, BR-DEL-016)', () => {
  it('computes ages correctly around birthdays', () => {
    expect(ageOn(new Date('2008-11-21T00:00:00Z'), new Date('2026-11-21T00:00:00Z'))).toBe(18);
    expect(ageOn(new Date('2008-11-22T00:00:00Z'), new Date('2026-11-21T00:00:00Z'))).toBe(17);
  });

  it('applies with a bicycle, submits, and on approval becomes a full partner', async () => {
    const a = await application({ type: 'BICYCLE' });
    const b = a.browser;
    const view = (await b.get('/partner/applications/me')).body.data;
    expect(view).toMatchObject({
      status: 'DRAFT',
      panMasked: 'XXXXXX234L',
      aadhaarMasked: 'XXXX XXXX 4321',
      vehicles: [expect.objectContaining({ type: 'BICYCLE', isActive: true })],
      bank: { accountMasked: 'XXXXXX5678', ifsc: 'HDFC0001234' },
      missing: [],
    });
    const row = await ctx.prisma.deliveryPartner.findUniqueOrThrow({ where: { userId: a.userId } });
    expect(ctx.container.fieldCipher.decrypt(row.panEncrypted!)).toBe('ABCPK1234L');

    expect((await b.post('/partner/applications/me/submit')).body.data.status).toBe('SUBMITTED');
    expect(
      (await b.patch('/partner/applications/me', { legalName: 'Other' })).body.error.code,
    ).toBe('APPLICATION_STATE_CONFLICT');
    await ctx.container.partnerOnboarding.decide(reviewer, row.id, { decision: 'APPROVED' });
    const after = (await b.get('/partner/me')).body.data;
    expect(after).toMatchObject({
      status: 'APPROVED',
      accountStatus: 'ACTIVE',
      documents: expect.arrayContaining([expect.objectContaining({ status: 'VERIFIED' })]),
    });
    const roles = await ctx.prisma.userRole.findMany({
      where: { userId: a.userId },
      include: { role: true },
    });
    expect(roles.map((r) => r.role.key)).toContain('DELIVERY_PARTNER');
    expect((await b.post('/partner/me/guidelines/ack', { version: '0.9' })).status).toBe(400);
    expect(
      (await b.post('/partner/me/guidelines/ack', { version: '1.0' })).body.data.guidelines
        .acknowledged,
    ).toBe('1.0');
  });

  it('needs licence, RC and insurance for motorized vehicles, and refuses under-18s', async () => {
    const motor = await application({ type: 'MOTORCYCLE', registrationNumber: 'ka 01 ab 1234' });
    const res = await motor.browser.post('/partner/applications/me/submit');
    expect(res.body.error.code).toBe('ONBOARDING_INCOMPLETE');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining([
        'documents.DL_FRONT',
        'documents.DL_BACK',
        'documents.RC',
        'documents.INSURANCE',
      ]),
    );
    expect((await motor.browser.get('/partner/me')).body.data.vehicles[0].registrationNumber).toBe(
      'KA01AB1234',
    );

    const young = await application({ type: 'BICYCLE' }, `${new Date().getFullYear() - 17}-01-01`);
    expect((await young.browser.post('/partner/applications/me/submit')).body.error.code).toBe(
      'AGE_REQUIREMENT_NOT_MET',
    );
  });
});
