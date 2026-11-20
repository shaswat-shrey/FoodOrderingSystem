import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  browser,
  createTestContext,
  integrationEnabled,
  signUpCustomer,
  uniquePhone,
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
  // Fresh rate-limit windows (several tests register accounts from one IP).
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  ctx.messages.clear();
});

suite('profile (API-USER-001/002/008, FR-CUST-001/002/007)', () => {
  it('returns and updates the profile', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const me = await b.get('/me');
    expect(me.body.data).toMatchObject({
      fullName: 'Test User',
      locale: 'en-IN',
      avatarUrl: null,
      phoneVerified: true,
    });
    const updated = await b.patch('/me', { fullName: 'Meera Iyer' });
    expect(updated.body.data.fullName).toBe('Meera Iyer');
    expect((await b.patch('/me', { locale: 'fr-FR' })).status).toBe(400);
    expect((await b.patch('/me', {})).status).toBe(400);
    const status = await b.get('/me/account-status');
    expect(status.body.data).toMatchObject({
      status: 'ACTIVE',
      phoneVerified: true,
      emailVerified: false,
    });
  });
});

suite('preferences (API-USER-006/007, FR-CUST-006)', () => {
  it('stores veg-only default, dietary tags and allergens, replacing the sets', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    expect((await b.get('/me/preferences')).body.data).toEqual({
      vegOnlyDefault: false,
      dietaryTags: [],
      allergens: [],
    });
    await b.patch('/me/preferences', {
      vegOnlyDefault: true,
      dietaryTags: ['JAIN', 'VEGAN'],
      allergens: ['PEANUTS'],
    });
    const res = await b.patch('/me/preferences', { allergens: ['MILK', 'MILK', 'SESAME'] });
    expect(res.body.data).toEqual({
      vegOnlyDefault: true,
      dietaryTags: ['JAIN', 'VEGAN'],
      allergens: ['MILK', 'SESAME'],
    });
    expect((await b.patch('/me/preferences', { allergens: ['PEANUT'] })).status).toBe(400);
  });

  it('is a customer-app endpoint', async () => {
    const { email, password } = await signUpCustomer(ctx);
    const partner = browser(ctx, 'RESTAURANT');
    partner.remember(await partner.post('/auth/login', { identifier: email, password }));
    const res = await partner.get('/me/preferences');
    expect(res.status).toBe(403);
  });
});

suite('email change (API-USER-009, FR-CUST-003)', () => {
  it('needs recent re-auth, rejects taken addresses, and starts the new email unverified', async () => {
    const { browser: b, password, email: oldEmail } = await signUpCustomer(ctx);
    expect((await b.post('/me/email/change', { email: 'new@example.com' })).body.error.code).toBe(
      'AUTH_REAUTH_REQUIRED',
    );
    await b.post('/auth/reauth', { password });
    const taken = await b.post('/me/email/change', { email: 'ASHA@example.com' }); // seeded customer
    expect(taken.body.error.code).toBe('AUTH_REGISTRATION_CONFLICT');

    const fresh = `changed${Date.now()}@example.com`;
    ctx.messages.clear();
    const res = await b.post('/me/email/change', { email: fresh });
    expect(res.status).toBe(200);
    const me = (await b.get('/me')).body.data;
    expect(me).toMatchObject({ email: fresh, emailVerified: false });
    expect(ctx.messages.sent.some((m) => m.to === fresh && m.template === 'VERIFY_EMAIL')).toBe(
      true,
    );
    // The old address was never verified, so it gets no notice.
    expect(ctx.messages.sent.some((m) => m.to === oldEmail)).toBe(false);
  });

  it('tells the old address when it was verified', async () => {
    const { browser: b, password, email: oldEmail, userId } = await signUpCustomer(ctx);
    await ctx.prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    await b.post('/auth/reauth', { password });
    ctx.messages.clear();
    await b.post('/me/email/change', { email: `moved${Date.now()}@example.com` });
    expect(ctx.messages.sent).toContainEqual(
      expect.objectContaining({
        to: oldEmail,
        template: 'SECURITY_ALERT',
        vars: expect.objectContaining({ event: 'EMAIL_CHANGED' }),
      }),
    );
  });
});

suite('phone change (API-USER-010/011, FR-CUST-004)', () => {
  it('verifies the new number, updates it and signs out other devices', async () => {
    const { browser: b, password, email, phone: oldPhone } = await signUpCustomer(ctx);
    const laptop = browser(ctx, 'CUSTOMER');
    laptop.remember(await laptop.post('/auth/login', { identifier: email, password }));
    expect((await laptop.get('/me')).status).toBe(200);

    const newPhone = uniquePhone();
    expect((await b.post('/me/phone/change', { phone: newPhone })).body.error.code).toBe(
      'AUTH_REAUTH_REQUIRED',
    );
    await b.post('/auth/reauth', { password });
    expect((await b.post('/me/phone/change', { phone: '+919000000101' })).body.error.code).toBe(
      'AUTH_REGISTRATION_CONFLICT',
    );
    expect((await b.post('/me/phone/change', { phone: newPhone })).status).toBe(200);
    const code = ctx.messages.lastOtp(newPhone)!;
    expect(
      (
        await b.post('/me/phone/change/confirm', {
          phone: newPhone,
          code: code === '000000' ? '111111' : '000000',
        })
      ).body.error.code,
    ).toBe('AUTH_OTP_INVALID');
    const done = await b.post('/me/phone/change/confirm', { phone: newPhone, code });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ phone: newPhone, phoneVerified: true });

    expect((await b.get('/me')).status).toBe(200);
    expect((await laptop.get('/me')).status).toBe(401); // other session revoked
    expect(ctx.messages.sent).toContainEqual(
      expect.objectContaining({
        to: oldPhone,
        template: 'SECURITY_ALERT',
        vars: expect.objectContaining({ event: 'PHONE_CHANGED' }),
      }),
    );
  });
});

suite('consents (API-USER-013/014, BR-AUTH-020)', () => {
  it('lists current documents and records acceptance of a new version once', async () => {
    const { browser: b, userId } = await signUpCustomer(ctx);
    const initial = (await b.get('/me/consents')).body.data as {
      type: string;
      legalDocumentId: string;
      acceptedAt: string | null;
    }[];
    expect(initial.map((d) => d.type)).toEqual(['PRIVACY', 'TERMS']);
    expect(initial.every((d) => d.acceptedAt)).toBe(true); // accepted at sign-up

    // user_consents is append-only, so this document stays; the test database is reseeded every run.
    const doc = await ctx.prisma.legalDocument.create({
      data: {
        type: 'TERMS',
        version: `9.${Date.now()}`,
        content: 'test',
        isMaterial: true,
        publishedAt: new Date(Date.now() - 60_000),
      },
    });
    const pending = (await b.get('/me/consents')).body.data.find(
      (d: { type: string }) => d.type === 'TERMS',
    );
    expect(pending).toMatchObject({ legalDocumentId: doc.id, acceptedAt: null, isMaterial: true });
    await b.post('/me/consents', { legalDocumentId: doc.id });
    const again = await b.post('/me/consents', { legalDocumentId: doc.id });
    expect(
      again.body.data.find((d: { type: string }) => d.type === 'TERMS').acceptedAt,
    ).not.toBeNull();
    expect(await ctx.prisma.userConsent.count({ where: { userId, legalDocumentId: doc.id } })).toBe(
      1,
    );
    const stale = await b.post('/me/consents', { legalDocumentId: initial[1]!.legalDocumentId });
    expect(stale.status).toBe(404); // superseded version
  });
});
