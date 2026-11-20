import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCipher, fieldCipherFrom } from './crypto';

describe('field encryption (NFR-SEC-005)', () => {
  it('round-trips, randomises, detects tampering and rotates keys', () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const old = new FieldCipher([{ id: 1, key: k1 }], 1);
    const a = old.encrypt('ABCDE1234F');
    expect(old.decrypt(a)).toBe('ABCDE1234F');
    expect(Buffer.from(old.encrypt('ABCDE1234F')).equals(Buffer.from(a))).toBe(false);
    const tampered = Buffer.from(a);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => old.decrypt(tampered)).toThrow();

    const rotated = new FieldCipher(
      [
        { id: 1, key: k1 },
        { id: 2, key: k2 },
      ],
      2,
    );
    expect(rotated.decrypt(a)).toBe('ABCDE1234F');
    expect(rotated.encrypt('x')[0]).toBe(2);
  });

  it('derives a stable development key and parses configured keys', () => {
    const env = { AUTH_HMAC_SECRET: 'h'.repeat(32) };
    expect(fieldCipherFrom(env).decrypt(fieldCipherFrom(env).encrypt('ok'))).toBe('ok');
    const key = randomBytes(32).toString('base64');
    const c = fieldCipherFrom({ ...env, FIELD_ENCRYPTION_KEYS: `3:${key}` });
    expect(c.encrypt('y')[0]).toBe(3);
  });
});
