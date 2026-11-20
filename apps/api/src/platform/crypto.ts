import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

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

/**
 * Field-level encryption for PAN, bank account numbers and change-request
 * payloads (NFR-SEC-005, DB-CONV: `*_encrypted` columns). AES-256-GCM; the
 * stored value is `keyId(1) | iv(12) | tag(16) | ciphertext`, so keys can rotate.
 */
export class FieldCipher {
  private readonly keys: Map<number, Buffer>;

  constructor(
    keys: { id: number; key: Buffer }[],
    private readonly currentId: number,
  ) {
    for (const k of keys)
      if (k.key.length !== 32 || k.id < 1 || k.id > 255) throw new Error('invalid field key');
    this.keys = new Map(keys.map((k) => [k.id, k.key]));
    if (!this.keys.has(currentId)) throw new Error('current field key missing');
  }

  encrypt(plain: string): Digest {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentId)!, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return new Uint8Array(
      Buffer.concat([Buffer.from([this.currentId]), iv, cipher.getAuthTag(), body]),
    );
  }

  decrypt(stored: Uint8Array): string {
    const buf = Buffer.from(stored);
    const key = this.keys.get(buf[0]!);
    if (!key) throw new Error('unknown field key');
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 13));
    decipher.setAuthTag(buf.subarray(13, 29));
    return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString('utf8');
  }
}

/**
 * `FIELD_ENCRYPTION_KEYS` = "1:<base64 32 bytes>,2:<…>" (newest last is current).
 * Outside production a key is derived from AUTH_HMAC_SECRET so development works
 * without setup; production requires explicit keys (env.ts).
 */
export function fieldCipherFrom(env: {
  FIELD_ENCRYPTION_KEYS?: string | undefined;
  AUTH_HMAC_SECRET: string;
}): FieldCipher {
  if (!env.FIELD_ENCRYPTION_KEYS) {
    const key = Buffer.from(
      hkdfSync('sha256', env.AUTH_HMAC_SECRET, 'fos', 'field-encryption-dev', 32),
    );
    return new FieldCipher([{ id: 1, key }], 1);
  }
  const keys = parseFieldKeys(env.FIELD_ENCRYPTION_KEYS);
  return new FieldCipher(keys, keys.at(-1)!.id);
}

export function parseFieldKeys(value: string): { id: number; key: Buffer }[] {
  return value.split(',').map((part) => {
    const [id, b64] = part.trim().split(':');
    return { id: Number(id), key: Buffer.from(b64 ?? '', 'base64') };
  });
}
