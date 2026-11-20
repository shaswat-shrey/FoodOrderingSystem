import { describe, expect, it } from 'vitest';
import { hmac, randomDigits, randomToken, safeEqual, sha256 } from './crypto';

describe('crypto helpers', () => {
  it('creates 256-bit url-safe tokens', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it('separates HMAC domains', () => {
    expect(hmac('k'.repeat(32), 'otp', 'x').equals(hmac('k'.repeat(32), 'identifier', 'x'))).toBe(
      false,
    );
    expect(hmac('k'.repeat(32), 'otp', 'x').equals(hmac('k'.repeat(32), 'otp', 'x'))).toBe(true);
  });

  it('compares safely across lengths', () => {
    expect(safeEqual(sha256('a'), sha256('a'))).toBe(true);
    expect(safeEqual(sha256('a'), Buffer.from('a'))).toBe(false);
  });

  it('generates fixed-length numeric codes with every digit position used', () => {
    const codes = Array.from({ length: 2000 }, () => randomDigits(6));
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes.map((c) => c[0])).size).toBe(10);
  });
});
