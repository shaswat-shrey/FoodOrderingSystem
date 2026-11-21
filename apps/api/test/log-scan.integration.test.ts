import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import type { MockPaymentProvider } from '../src/modules/payments';
import {
  branchId,
  browser,
  createTestContext,
  integrationEnabled,
  placeOrder,
  refreshCookie,
  signUpCustomer,
  uniquePhone,
  type TestContext,
} from './helpers';

/**
 * AC-NFR-003 (NFR-SEC-014): an automated scan of everything the API logged while
 * running the sensitive flows — sign-up, phone codes, password and OTP sign-in,
 * refresh (including a replay), online payment and order placement — for secrets
 * and full phone numbers. Logging runs at debug level, so nothing is filtered out
 * before the scan.
 */
const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});

const key = () => ({ 'Idempotency-Key': uuidv7() });

suite('log scan (AC-NFR-003, NFR-SEC-014)', () => {
  it('logs no passwords, one-time codes, tokens, payment signatures or full phone numbers', async () => {
    ctx.logs.length = 0;
    const secrets = new Set<string>();
    const phones = new Set<string>();
    const keep = (value: unknown) => {
      if (typeof value === 'string' && value.length >= 4) secrets.add(value);
    };

    // Sign-up with a password and the phone code.
    const c = await signUpCustomer(ctx, { password: 'tamarind rasam on tuesdays' });
    keep(c.password);
    keep(c.initialRefreshToken);
    keep(c.browser.token);
    phones.add(c.phone);

    // Wrong then right password; refresh, then a stolen-token replay after the grace window.
    const b = browser(ctx);
    await b.post('/auth/login', { identifier: c.phone, password: 'not the password at all' });
    const signedIn = b.remember(
      await b.post('/auth/login', { identifier: c.phone, password: c.password }),
    );
    keep(signedIn.body.data?.accessToken);
    keep(refreshCookie(signedIn));
    const refreshed = b.remember(await b.post('/auth/refresh'));
    expect(refreshed.status).toBe(200);
    keep(refreshed.body.data.accessToken);
    keep(refreshCookie(refreshed));
    ctx.clock.advance(11_000);
    const replay = await browser(ctx)
      .agent.post('/api/v1/auth/refresh')
      .set('X-Client-App', 'CUSTOMER')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `fos_rt_customer=${refreshCookie(signedIn)}`);
    expect(replay.body.error.code).toBe('AUTH_REFRESH_REUSED');

    // OTP sign-in for a new number: a wrong code, then the right one.
    const phone = uniquePhone();
    phones.add(phone);
    const o = browser(ctx);
    await o.post('/auth/otp/request', { phone, purpose: 'LOGIN' });
    await o.post('/auth/otp/login', { phone, code: '000000', acceptTerms: true });
    const otpLogin = o.remember(
      await o.post('/auth/otp/login', {
        phone,
        code: ctx.messages.lastOtp(phone)!,
        acceptTerms: true,
        fullName: 'Log Scan',
      }),
    );
    keep(otpLogin.body.data?.accessToken);
    keep(refreshCookie(otpLogin));

    // An online order paid through the provider (a forged signature first), and a COD order.
    const saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
    const rid = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } }))
      .restaurantId;
    const item = await ctx.prisma.foodItem.findFirstOrThrow({
      where: { restaurantId: rid, name: 'Paneer Biryani' },
    });
    const mild = await ctx.prisma.customizationOption.findFirstOrThrow({
      where: { name: 'Mild', group: { restaurantId: rid } },
    });
    const items = [{ foodItemId: item.id, optionIds: [mild.id], quantity: 1 }];
    const online = await placeOrder(ctx, { branchId: saffron, items, paymentMethod: 'ONLINE' });
    phones.add(online.phone);
    keep(online.password);
    keep(online.browser.token);
    const init = (await online.browser.post(`/orders/${online.orderId}/payments`, {}, key())).body
      .data;
    const mock = ctx.container.paymentProvider as MockPaymentProvider;
    const paid = mock.pay(init.providerOrderId, 'success');
    keep(paid.signature);
    await online.browser.post(
      `/payments/${init.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: 'ab'.repeat(32) },
      key(),
    );
    const verified = await online.browser.post(
      `/payments/${init.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      key(),
    );
    expect(verified.body.data.status).toBe('CAPTURED');
    const cod = await placeOrder(ctx, { branchId: saffron, items, paymentMethod: 'COD' });
    phones.add(cod.phone);
    await ctx.container.outboxRelay.runOnce();

    for (const m of ctx.messages.sent) if (m.template === 'OTP') keep(m.vars.code);

    const log = ctx.logs.join('');
    expect(log.length).toBeGreaterThan(1000); // the flows above did log
    const leaked = [...secrets].filter((s) => log.includes(s));
    expect(leaked, 'secrets found in the logs').toEqual([]);
    const fullPhones = [...phones].filter((p) => log.includes(p) || log.includes(p.slice(-10)));
    expect(fullPhones, 'full phone numbers found in the logs').toEqual([]);
    // Redacted fields keep their key, so redaction (not luck) is what removed them.
    expect(log).not.toMatch(/"(password|otp|accessToken|refreshToken)":"(?!\[REDACTED\])/);
  });
});
