import { createHmac, randomInt } from 'node:crypto';

/** Crockford base32: no I, L, O, U — easy to read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * FR-ORDER-003: unique, non-sequential, ≤ 13 characters: `YYMMDD-XXXXXX`
 * (IST date + 30 random bits). Uniqueness is enforced by the database; the
 * caller retries on the rare collision. (FR-ORDER-001's `FOS-` prefix would
 * exceed 13 characters — see discrepancy D-10.)
 */
export function newOrderNumber(now: Date): string {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const ymd = ist.toISOString().slice(2, 10).replace(/-/g, '');
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += ALPHABET[randomInt(32)];
  return `${ymd}-${suffix}`;
}

/**
 * BR-DEL-009 delivery code: 4 digits derived from the order id with a server
 * secret, so the customer's app can always show it (FR-CORD-006) while the
 * database only stores its hash for verification.
 */
export function deliveryCode(secret: string, orderId: string): string {
  const digest = createHmac('sha256', secret).update(`delivery-otp:${orderId}`).digest();
  return String(digest.readUInt32BE(0) % 10_000).padStart(4, '0');
}

export const deliveryCodeHash = (secret: string, orderId: string, code: string) =>
  createHmac('sha256', secret).update(`delivery-otp-hash:${orderId}:${code}`).digest();
