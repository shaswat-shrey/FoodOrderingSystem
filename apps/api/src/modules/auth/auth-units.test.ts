import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../platform/clock';
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from './password';
import { lockMinutesFor } from './policy';
import { TokenError, TokenService } from './tokens';

const keyA = { kid: 'a', secret: 'a'.repeat(32) };
const keyB = { kid: 'b', secret: 'b'.repeat(32) };
const claims = {
  userId: '0193b0b6-0000-7000-8000-000000000001',
  sessionId: '0193b0b6-0000-7000-8000-000000000002',
  app: 'CUSTOMER' as const,
  roles: ['CUSTOMER'],
  scope: 'FULL' as const,
  permissionVersion: 3,
  tokenVersion: 1,
};

describe('passwords (BR-AUTH-001)', () => {
  it('hashes with Argon2id and verifies', async () => {
    const hashed = await hashPassword('correct horse battery');
    expect(hashed.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await verifyPassword(hashed, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hashed, 'wrong horse battery')).toBe(false);
    expect(needsRehash(hashed)).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$abc$def')).toBe(true);
  });

  it('enforces length, breach list and identity rules without composition rules', () => {
    expect(checkPasswordPolicy('short')).toBe('AUTH_PASSWORD_WEAK');
    expect(checkPasswordPolicy('x'.repeat(129))).toBe('AUTH_PASSWORD_WEAK');
    expect(checkPasswordPolicy('Password@123')).toBe('AUTH_PASSWORD_BREACHED');
    expect(checkPasswordPolicy('aaaaaaaaaa')).toBe('AUTH_PASSWORD_WEAK');
    expect(checkPasswordPolicy('asha@example.com', { email: 'Asha@Example.com' })).toBe(
      'AUTH_PASSWORD_WEAK',
    );
    expect(checkPasswordPolicy('9000000101', { phone: '+919000000101' })).toBe(
      'AUTH_PASSWORD_WEAK',
    );
    expect(checkPasswordPolicy('masala dosa on sunday')).toBeNull();
  });
});

describe('lockout schedule (BR-AUTH-004)', () => {
  it('locks for 15 minutes after 5 failures, doubling, capped at 24 h', () => {
    expect(lockMinutesFor(4)).toBe(0);
    expect(lockMinutesFor(5)).toBe(15);
    expect(lockMinutesFor(10)).toBe(30);
    expect(lockMinutesFor(15)).toBe(60);
    expect(lockMinutesFor(500)).toBe(1440);
  });
});

describe('access tokens (ADR-003, FR-AUTH-020/021)', () => {
  it('round-trips claims and binds the audience to the app', async () => {
    const clock = new ManualClock();
    const tokens = new TokenService([keyA], 'fos-api', clock);
    const { token, expiresAt } = await tokens.sign(claims);
    expect(expiresAt.getTime() - clock.now().getTime()).toBe(15 * 60 * 1000);
    expect(await tokens.verify(token, 'CUSTOMER')).toEqual(claims);
    await expect(tokens.verify(token, 'ADMIN')).rejects.toThrow(TokenError);
  });

  it('expires after 15 minutes', async () => {
    const clock = new ManualClock();
    const tokens = new TokenService([keyA], 'fos-api', clock);
    const { token } = await tokens.sign(claims);
    clock.advance(15 * 60 * 1000 + 1000);
    await expect(tokens.verify(token, 'CUSTOMER')).rejects.toMatchObject({ reason: 'EXPIRED' });
  });

  it('supports key rotation: old tokens verify while the new key signs', async () => {
    const clock = new ManualClock();
    const oldToken = (await new TokenService([keyA], 'fos-api', clock).sign(claims)).token;
    const rotated = new TokenService([keyB, keyA], 'fos-api', clock);
    expect((await rotated.verify(oldToken, 'CUSTOMER')).userId).toBe(claims.userId);
    const retired = new TokenService([keyB], 'fos-api', clock);
    await expect(retired.verify(oldToken, 'CUSTOMER')).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('rejects tampered tokens and the "none" algorithm', async () => {
    const tokens = new TokenService([keyA], 'fos-api', new ManualClock());
    const { token } = await tokens.sign(claims);
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.roles = ['SUPER_ADMIN'];
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    await expect(tokens.verify(forged, 'CUSTOMER')).rejects.toThrow(TokenError);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'a' })).toString('base64url')}.${p}.`;
    await expect(tokens.verify(none, 'CUSTOMER')).rejects.toThrow(TokenError);
  });
});
