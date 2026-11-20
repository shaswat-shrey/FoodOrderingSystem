import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random secret (default 256 bits) for refresh, reset and verification tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Digest bytes in the shape Prisma's `Bytes` columns accept. */
export type Digest = Uint8Array<ArrayBuffer>;

/** SHA-256 digest. Used for high-entropy tokens, where a fast hash is sufficient (ADR-003). */
export function sha256(value: string | Uint8Array): Digest {
  return new Uint8Array(createHash('sha256').update(value).digest());
}

/**
 * Keyed hash with domain separation, so the same secret can't produce
 * interchangeable digests for different purposes (OTP codes vs identifiers).
 */
export function hmac(secret: string, domain: string, value: string): Digest {
  return new Uint8Array(createHmac('sha256', secret).update(`${domain}\u0000${value}`).digest());
}

/** Constant-time comparison that also tolerates different lengths. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Uniformly random numeric code (no modulo bias) — OTPs and delivery codes. */
export function randomDigits(length: number): string {
  const max = 10 ** length;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0);
    if (n < limit) return String(n % max).padStart(length, '0');
  }
}
