import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  browser,
  createTestContext,
  integrationEnabled,
  refreshCookie,
  setPassword,
  signUpCustomer,
  uniquePhone,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;

beforeAll(async () => {
  if (integrationEnabled) ctx = await createTestContext();
});
afterAll(async () => ctx?.close());
beforeEach(async () => {
  if (!integrationEnabled) return;
  // Each test starts with fresh rate-limit windows and caches.
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  ctx.messages.clear();
});

suite('registration (FR-AUTH-001, AC-AUTH-002)', () => {
  it('creates an unverified account, a session and a hardened refresh cookie', async () => {
    const b = browser(ctx);
    const phone = uniquePhone();
    const res = await b.post('/auth/register', {
      fullName: 'Asha Rao',
      email: `asha.${phone.slice(-6)}@example.com`,
      phone,
      password: 'ghee roast dosa 42',
      acceptTerms: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({
      status: 'PENDING_VERIFICATION',
      phoneVerified: false,
      roles: ['CUSTOMER'],
      scope: 'FULL',
    });
    expect(res.body.data.accessToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('refresh');

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('fos_rt_customer='),
    )!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

    const user = await ctx.prisma.user.findFirstOrThrow({
      where: { phone },
      include: { credential: true, consents: true },
    });
    expect(user.credential?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(user.consents).toHaveLength(2); // terms + privacy
    expect(ctx.messages.lastOtp(phone)).toMatch(/^\d{6}$/);
    expect(ctx.messages.sent.some((m) => m.template === 'VERIFY_EMAIL')).toBe(true);
  });

  it('requires phone verification before other features (AUTH_VERIFICATION_REQUIRED)', async () => {
    const b = browser(ctx);
    const phone = uniquePhone();
    b.remember(
      await b.post('/auth/register', {
        fullName: 'Rahul',
        email: `r${phone.slice(-6)}@example.com`,
        phone,
        password: 'filter coffee 2026',
        acceptTerms: true,
      }),
    );
    expect((await b.get('/me')).status).toBe(200);
    const blocked = await b.get('/me/permissions');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('AUTH_VERIFICATION_REQUIRED');
    expect((await b.post('/auth/phone/verify', { code: '000000' })).body.error.code).toBe(
      'AUTH_OTP_INVALID',
    );
    expect((await b.post('/auth/phone/verify', { code: ctx.messages.lastOtp(phone) })).status).toBe(
      200,
    );
    expect((await b.get('/me/permissions')).status).toBe(200);
  });

  it('rejects weak or common passwords and duplicate details without saying which', async () => {
    const b = browser(ctx);
    const phone = uniquePhone();
    const base = {
      fullName: 'Test',
      email: `w${phone.slice(-6)}@example.com`,
      phone,
      acceptTerms: true,
    };
    expect(
      (await b.post('/auth/register', { ...base, password: 'Password@123' })).body.error.code,
    ).toBe('AUTH_PASSWORD_BREACHED');
    expect((await b.post('/auth/register', { ...base, password: 'short' })).body.error.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      (await b.post('/auth/register', { ...base, password: 'a fine long phrase' })).status,
    ).toBe(201);
    const dup = await browser(ctx).post('/auth/register', {
      ...base,
      phone: uniquePhone(),
      password: 'another long phrase',
    });
    expect(dup.body.error.code).toBe('AUTH_REGISTRATION_CONFLICT');
    expect(dup.body.message).not.toMatch(/email|phone/i);
  });

  it('does not allow self-registration in the admin app', async () => {
    const res = await browser(ctx, 'ADMIN').post('/auth/register', {
      fullName: 'Mallory',
      email: 'mallory@example.com',
      phone: uniquePhone(),
      password: 'let me in please',
      acceptTerms: true,
    });
    expect(res.body.error.code).toBe('AUTH_APP_NOT_PERMITTED');
  });
});

suite('OTP sign-in (FR-AUTH-002/010, AC-AUTH-001/011)', () => {
  it('signs up a new customer on first OTP login, only with accepted terms', async () => {
    const b = browser(ctx);
    const phone = uniquePhone();
    expect((await b.post('/auth/otp/request', { phone, purpose: 'LOGIN' })).status).toBe(200);
    const code = ctx.messages.lastOtp(phone)!;
    expect((await b.post('/auth/otp/login', { phone, code })).body.error.code).toBe(
      'AUTH_TERMS_REQUIRED',
    );
    // The code is checked (and consumed) before the account lookup, so the terms
    // prompt never reveals whether a number is registered; a fresh code is needed.
    expect(
      (await b.post('/auth/otp/login', { phone, code, acceptTerms: true })).body.error.code,
    ).toBe('AUTH_OTP_INVALID');
    ctx.clock.advance(31_000);
    await b.post('/auth/otp/request', { phone, purpose: 'LOGIN' });
    const res = b.remember(
      await b.post('/auth/otp/login', {
        phone,
        code: ctx.messages.lastOtp(phone),
        acceptTerms: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      status: 'ACTIVE',
      phoneVerified: true,
      profileComplete: false,
      roles: ['CUSTOMER'],
    });
    expect((await b.get('/me')).body.data.phone).toBe(phone);
  });

  it('enforces resend cooldown, single use, expiry and the attempt limit', async () => {
    const b = browser(ctx);
    const phone = uniquePhone();
    await b.post('/auth/otp/request', { phone, purpose: 'LOGIN' });
    const cooldown = await b.post('/auth/otp/request', { phone, purpose: 'LOGIN' });
    expect(cooldown.status).toBe(429);

    ctx.clock.advance(31_000);
    await b.post('/auth/otp/request', { phone, purpose: 'LOGIN' });
    const code = ctx.messages.lastOtp(phone)!;
    for (let i = 0; i < 4; i += 1) {
      expect(
        (
          await b.post('/auth/otp/login', {
            phone,
            code: code === '000000' ? '111111' : '000000',
            acceptTerms: true,
          })
        ).body.error.code,
      ).toBe('AUTH_OTP_INVALID');
    }
    const fifth = await b.post('/auth/otp/login', {
      phone,
      code: code === '000000' ? '111111' : '000000',
      acceptTerms: true,
    });
    expect(fifth.body.error.code).toBe('AUTH_OTP_ATTEMPTS_EXCEEDED');
    // Even the right code is now dead.
    expect((await b.post('/auth/otp/login', { phone, code, acceptTerms: true })).status).toBe(422);

    ctx.clock.advance(31_000);
    await b.post('/auth/otp/request', { phone, purpose: 'LOGIN' });
    const fresh = ctx.messages.lastOtp(phone)!;
    ctx.clock.advance(5 * 60_000 + 1000);
    expect(
      (await b.post('/auth/otp/login', { phone, code: fresh, acceptTerms: true })).body.error.code,
    ).toBe('AUTH_OTP_EXPIRED');
  });

  it('stores only an HMAC of the code', async () => {
    const phone = uniquePhone();
    await browser(ctx).post('/auth/otp/request', { phone, purpose: 'LOGIN' });
    const code = ctx.messages.lastOtp(phone)!;
    const rows = await ctx.prisma.$queryRaw<
      { code_hmac: Uint8Array }[]
    >`SELECT code_hmac FROM otp_codes ORDER BY created_at DESC LIMIT 1`;
    expect(Buffer.from(rows[0]!.code_hmac).toString('utf8')).not.toContain(code);
    expect(Buffer.from(rows[0]!.code_hmac)).toHaveLength(32);
  });
});

suite('password sign-in & lockout (FR-AUTH-003, BR-AUTH-004, AC-AUTH-003/004)', () => {
  it('gives identical responses for an unknown user and a wrong password', async () => {
    const { email } = await signUpCustomer(ctx);
    const unknown = await browser(ctx).post('/auth/login', {
      identifier: 'nobody@example.com',
      password: 'whatever it is',
    });
    const wrong = await browser(ctx).post('/auth/login', {
      identifier: email,
      password: 'not my password',
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error).toEqual(wrong.body.error);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it('locks after 5 failures, rejects the right password while locked, then unlocks after 15 minutes', async () => {
    const { email, password, userId } = await signUpCustomer(ctx);
    for (let i = 0; i < 5; i += 1) {
      expect(
        (
          await browser(ctx).post('/auth/login', {
            identifier: email,
            password: `wrong ${i} attempt`,
          })
        ).status,
      ).toBe(401);
    }
    await ctx.redis.core.flushdb(); // the per-identifier rate-limit window has passed
    const locked = await browser(ctx).post('/auth/login', { identifier: email, password });
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(
      ctx.messages.sent.some(
        (m) => m.template === 'SECURITY_ALERT' && m.vars.event === 'ACCOUNT_LOCKED',
      ),
    ).toBe(true);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'auth.account_locked', targetId: userId },
      }),
    ).toBe(1);

    ctx.clock.advance(15 * 60_000 + 1000);
    await ctx.redis.core.flushdb();
    expect((await browser(ctx).post('/auth/login', { identifier: email, password })).status).toBe(
      200,
    );
  });

  it('blocks suspended accounts after the password is proven', async () => {
    const { email, password, userId } = await signUpCustomer(ctx);
    await ctx.prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });
    const res = await browser(ctx).post('/auth/login', { identifier: email, password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });

  it('accepts a 10-digit phone as identifier and refuses apps the user has no access to', async () => {
    const { phone, password } = await signUpCustomer(ctx);
    expect(
      (await browser(ctx).post('/auth/login', { identifier: phone.slice(3), password })).status,
    ).toBe(200);
    const admin = await browser(ctx, 'ADMIN').post('/auth/login', { identifier: phone, password });
    expect(admin.body.error.code).toBe('AUTH_APP_NOT_PERMITTED');
  });

  it('gives restaurant-app applicants an onboarding-only session (BR-AUTH-010)', async () => {
    const b = browser(ctx, 'RESTAURANT');
    const phone = uniquePhone();
    const res = await b.post('/auth/register', {
      fullName: 'New Owner',
      email: `o${phone.slice(-6)}@example.com`,
      phone,
      password: 'tandoori nights 99',
      acceptTerms: true,
    });
    expect(res.body.data.user.scope).toBe('ONBOARDING');
    expect(res.body.data.user.roles).toEqual([]);
  });
});

suite('admin second factor (BR-AUTH-018)', () => {
  it('requires an emailed code before an admin session is created', async () => {
    const admin = await ctx.prisma.user.findFirstOrThrow({ where: { email: 'admin@example.com' } });
    await setPassword(ctx.prisma, admin.id, 'admin console passphrase');
    const b = browser(ctx, 'ADMIN');
    const first = await b.post('/auth/login', {
      identifier: 'admin@example.com',
      password: 'admin console passphrase',
    });
    expect(first.status).toBe(200);
    expect(first.body.data.mfaRequired).toBe(true);
    expect(refreshCookie(first, 'ADMIN')).toBeUndefined();
    expect(
      (await b.post('/auth/mfa/challenge', { mfaToken: first.body.data.mfaToken, code: '000000' }))
        .body.error.code,
    ).toBe('AUTH_MFA_INVALID');
    const code = ctx.messages.lastOtp('admin@example.com')!;
    const done = await b.post('/auth/mfa/challenge', { mfaToken: first.body.data.mfaToken, code });
    expect(done.status).toBe(200);
    expect(done.body.data.user.roles).toContain('ADMIN');
    expect(refreshCookie(done, 'ADMIN')).toBeTruthy();
  });
});

suite('refresh rotation (FR-AUTH-022, AC-AUTH-005/006/007)', () => {
  it('rotates: new access + refresh token, exactly one active token per session', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const res = b.remember(await b.post('/auth/refresh'));
    expect(res.status).toBe(200);
    expect(refreshCookie(res)).toBeTruthy();
    const sessionId = res.body.data.session.id as string;
    expect(await ctx.prisma.refreshToken.count({ where: { sessionId, status: 'ACTIVE' } })).toBe(1);
    expect(
      await ctx.prisma.refreshToken.count({ where: { sessionId, status: 'ROTATED' } }),
    ).toBeGreaterThan(0);
    expect((await b.get('/me')).status).toBe(200);
  });

  it('revokes the session when a rotated token is replayed after the grace window', async () => {
    const { browser: b, userId, initialRefreshToken } = await signUpCustomer(ctx);
    expect((await b.post('/auth/refresh')).status).toBe(200); // rotates the initial token

    ctx.clock.advance(11_000);
    const replay = await replayRefresh(initialRefreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('AUTH_REFRESH_REUSED');
    // The legitimate holder of the newest token is signed out too.
    expect((await b.post('/auth/refresh')).status).toBe(401);
    expect((await b.get('/me')).status).toBe(401);
    expect(
      ctx.messages.sent.some(
        (m) => m.template === 'SECURITY_ALERT' && m.vars.event === 'SESSION_REUSE_DETECTED',
      ),
    ).toBe(true);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'auth.refresh_reuse_detected', actorUserId: userId },
      }),
    ).toBe(1);
  });

  it('treats a replay inside the grace window as a race and keeps the session (multi-tab)', async () => {
    const { browser: b, initialRefreshToken } = await signUpCustomer(ctx);
    expect((await b.post('/auth/refresh')).status).toBe(200);
    const race = await replayRefresh(initialRefreshToken); // a second tab sent the old cookie
    expect(race.status).toBe(409);
    expect(race.body.error.code).toBe('AUTH_REFRESH_RACE');
    expect((await b.post('/auth/refresh')).status).toBe(200);
  });

  it('rejects refresh from an untrusted origin (CSRF, BR-AUTH-019)', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const res = await b.agent
      .post('/api/v1/auth/refresh')
      .set('X-Client-App', 'CUSTOMER')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
  });
});

/** Sends a refresh request carrying a specific (possibly stolen) refresh token. */
function replayRefresh(token: string) {
  return browser(ctx)
    .agent.post('/api/v1/auth/refresh')
    .set('X-Client-App', 'CUSTOMER')
    .set('Origin', 'http://localhost:5173')
    .set('Cookie', `fos_rt_customer=${token}`);
}

suite('sessions & logout (FR-AUTH-005/006/007, AC-AUTH-008/009/010)', () => {
  it('lists own sessions and hides other users’ sessions', async () => {
    const alice = await signUpCustomer(ctx);
    const bob = await signUpCustomer(ctx);
    const list = await alice.browser.get('/auth/sessions');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ current: true, app: 'CUSTOMER' });
    const bobSession = (await bob.browser.get('/auth/sessions')).body.data[0].id;
    const res = await alice.browser.delete(`/auth/sessions/${bobSession}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AUTH_SESSION_NOT_FOUND');
  });

  it('revoking a session rejects its access token immediately', async () => {
    const { browser: phoneDevice, email, password } = await signUpCustomer(ctx);
    const laptop = browser(ctx);
    laptop.remember(await laptop.post('/auth/login', { identifier: email, password }));
    const laptopSession = (await laptop.get('/auth/sessions')).body.data.find(
      (s: { current: boolean }) => s.current,
    ).id;
    expect((await phoneDevice.delete(`/auth/sessions/${laptopSession}`)).status).toBe(200);
    const res = await laptop.get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_SESSION_REVOKED');
  });

  it('logout-all signs out every device and invalidates outstanding access tokens', async () => {
    const { browser: a, email, password } = await signUpCustomer(ctx);
    const other = browser(ctx);
    other.remember(await other.post('/auth/login', { identifier: email, password }));
    expect(
      (await a.post('/auth/logout-all', { keepCurrent: false })).body.data.revokedSessions,
    ).toBe(2);
    expect((await other.get('/me')).status).toBe(401);
    expect((await a.get('/me')).status).toBe(401);
    expect((await other.post('/auth/refresh')).status).toBe(401);
  });

  it('logout revokes the session even with an expired access token, via the cookie', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    ctx.clock.advance(16 * 60_000);
    expect((await b.get('/me')).body.error.code).toBe('AUTH_TOKEN_EXPIRED');
    const res = await b.post('/auth/logout');
    expect(res.status).toBe(200);
    expect(
      (res.headers['set-cookie'] as unknown as string[]).some((c) =>
        c.startsWith('fos_rt_customer=;'),
      ),
    ).toBe(true);
    expect((await b.post('/auth/refresh')).status).toBe(401);
  });

  it('does not accept a customer-app token in the admin app (audience)', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const res = await b.agent
      .get('/api/v1/me')
      .set('X-Client-App', 'ADMIN')
      .set('Authorization', `Bearer ${b.token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });
});

suite('passwords (FR-AUTH-011/012/013, AC-AUTH-012)', () => {
  it('responds identically to forgot-password for unknown accounts', async () => {
    const { email } = await signUpCustomer(ctx);
    ctx.messages.clear();
    const known = await browser(ctx).post('/auth/password/forgot', { identifier: email });
    const unknown = await browser(ctx).post('/auth/password/forgot', {
      identifier: 'ghost@example.com',
    });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body.message).toBe(unknown.body.message);
    expect(ctx.messages.sent).toHaveLength(1);
  });

  it('resets via emailed link, single-use, and signs out every session', async () => {
    const { browser: b, email } = await signUpCustomer(ctx);
    await browser(ctx).post('/auth/password/forgot', { identifier: email });
    const mail = ctx.messages.sent.find((m) => m.template === 'RESET_PASSWORD_EMAIL')!;
    const token = new URL(
      mail.template === 'RESET_PASSWORD_EMAIL' ? mail.vars.link : '',
    ).searchParams.get('token')!;
    expect(
      (
        await browser(ctx).post('/auth/password/reset', {
          token,
          newPassword: 'brand new pass phrase',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await browser(ctx).post('/auth/password/reset', {
          token,
          newPassword: 'another new phrase',
        })
      ).body.error.code,
    ).toBe('AUTH_TOKEN_USED');
    expect((await b.get('/me')).status).toBe(401);
    expect(
      (
        await browser(ctx).post('/auth/login', {
          identifier: email,
          password: 'brand new pass phrase',
        })
      ).status,
    ).toBe(200);
  });

  it('change-password keeps the current device signed in and signs out others', async () => {
    const { browser: a, email, password } = await signUpCustomer(ctx);
    const other = browser(ctx);
    other.remember(await other.post('/auth/login', { identifier: email, password }));
    expect(
      (
        await a.post('/auth/password/change', {
          currentPassword: 'wrong one',
          newPassword: 'x y z long enough',
        })
      ).status,
    ).toBe(401);
    const res = await a.post('/auth/password/change', {
      currentPassword: password,
      newPassword: 'a newer pass phrase',
    });
    expect(res.status).toBe(200);
    expect((await a.get('/me')).status).toBe(200);
    expect((await a.post('/auth/refresh')).status).toBe(200);
    expect((await other.get('/me')).status).toBe(401);
  });
});

suite('email verification (FR-AUTH-008)', () => {
  it('verifies via the emailed single-use link', async () => {
    const { browser: b, userId } = await signUpCustomer(ctx);
    const mail = ctx.messages.sent.find((m) => m.template === 'VERIFY_EMAIL')!;
    const token = new URL(mail.template === 'VERIFY_EMAIL' ? mail.vars.link : '').searchParams.get(
      'token',
    )!;
    expect((await b.post('/auth/email/verify', { token })).status).toBe(200);
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt,
    ).not.toBeNull();
    expect((await b.post('/auth/email/verify', { token })).body.error.code).toBe('AUTH_TOKEN_USED');
    expect((await b.post('/auth/email/send-verification')).body.error.code).toBe(
      'AUTH_EMAIL_ALREADY_VERIFIED',
    );
  });
});

suite('account deletion & reactivation (FR-AUTH-041/042, AC-AUTH-014)', () => {
  it('needs recent re-authentication, then deactivates, revokes sessions and anonymises after 30 days', async () => {
    const { browser: b, email, password, userId } = await signUpCustomer(ctx);
    expect((await b.post('/auth/account/deletion', { confirm: true })).body.error.code).toBe(
      'AUTH_REAUTH_REQUIRED',
    );
    expect((await b.post('/auth/reauth', { password })).status).toBe(200);
    const res = await b.post('/auth/account/deletion', { confirm: true });
    expect(res.status).toBe(200);
    expect((await b.get('/me')).status).toBe(401);

    // Signing in during the grace period offers reactivation instead of a session.
    const login = await browser(ctx).post('/auth/login', { identifier: email, password });
    expect(login.body.error.code).toBe('ACCOUNT_PENDING_DELETION');

    ctx.clock.advance(31 * 86_400_000);
    expect(await ctx.container.auth.anonymizeDueUsers()).toBeGreaterThanOrEqual(1);
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { credential: true },
    });
    expect(user).toMatchObject({
      status: 'ANONYMIZED',
      fullName: 'Deleted user',
      phone: null,
      credential: null,
    });
    expect(user.email).toMatch(/@deleted\.invalid$/);
  });

  it('lets a user reactivate during the grace period', async () => {
    const { browser: b, email, password } = await signUpCustomer(ctx);
    await b.post('/auth/reauth', { password });
    await b.post('/auth/account/deletion', { confirm: true });
    const login = await browser(ctx).post('/auth/login', { identifier: email, password });
    const token = login.body.error.details[0].message as string;
    const back = await browser(ctx).post('/auth/account/reactivate', { token });
    expect(back.status).toBe(200);
    expect(back.body.data.user.status).toBe('ACTIVE');
  });

  it('blocks deletion for the sole owner of an active restaurant', async () => {
    const owner = await ctx.prisma.user.findFirstOrThrow({ where: { phone: '+919000000201' } });
    expect(await ctx.container.auth.deletionBlockers(owner.id)).toContain('RESTAURANT_OWNER');
  });
});

suite('permissions (FR-AUTH-024, AC-RBAC-006)', () => {
  it('reflects a role removal on the next request without signing out', async () => {
    const { browser: b, userId } = await signUpCustomer(ctx);
    expect((await b.get('/me/permissions')).body.data.permissions).toContain('customer:order');
    await ctx.prisma.userRole.deleteMany({ where: { userId } });
    await ctx.container.iam.bumpPermissionVersion(userId);
    await ctx.container.sessions.invalidateUser(userId);
    const res = await b.get('/me/permissions');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_APP_NOT_PERMITTED');
  });
});

suite('log hygiene (NFR-SEC-014, AC-NFR-003)', () => {
  it('never logs passwords, OTPs, refresh tokens or access tokens', async () => {
    const { browser: b, password, phone, initialRefreshToken } = await signUpCustomer(ctx);
    const rotated = refreshCookie(await b.post('/auth/refresh'))!;
    const otps = ctx.messages.sent.flatMap((m) => (m.template === 'OTP' ? [m.vars.code] : []));
    const logs = ctx.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [password, initialRefreshToken, rotated, b.token!, ...otps]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).not.toContain(phone.slice(3)); // phone numbers aren't logged either
  });
});
