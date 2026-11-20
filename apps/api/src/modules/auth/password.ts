import { hash, verify } from '@node-rs/argon2';
import { COMMON_PASSWORDS } from './common-passwords';

/** Argon2id parameters (BR-AUTH-001, OWASP Password Storage Cheat Sheet). */
// `algorithm: 2` is Algorithm.Argon2id (a const enum, which verbatimModuleSyntax can't import).
export const ARGON2_PARAMS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** True when the stored hash used weaker or different parameters and should be upgraded on login. */
export function needsRehash(passwordHash: string): boolean {
  const { memoryCost, timeCost, parallelism } = ARGON2_PARAMS;
  return !passwordHash.startsWith(`$argon2id$v=19$m=${memoryCost},t=${timeCost},p=${parallelism}$`);
}

let dummyHash: Promise<string> | undefined;
/**
 * Verifies against a fixed hash so that "unknown user" takes as long as "wrong
 * password" (FR-AUTH-003 step 2 — no account enumeration by timing).
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equaliser-not-a-real-password');
  await verifyPassword(await dummyHash, password);
}

export type PasswordIssue = 'AUTH_PASSWORD_WEAK' | 'AUTH_PASSWORD_BREACHED';

/**
 * BR-AUTH-001: 8–128 characters, no composition rules (NIST SP 800-63B), not a
 * known-breached/common password, not the user's own email or phone.
 */
export function checkPasswordPolicy(
  password: string,
  context: { email?: string | null; phone?: string | null } = {},
): PasswordIssue | null {
  const length = [...password].length;
  if (length < 8 || length > 128) return 'AUTH_PASSWORD_WEAK';
  const lower = password.toLowerCase();
  if (context.email && lower === context.email.toLowerCase()) return 'AUTH_PASSWORD_WEAK';
  if (
    context.phone &&
    (password === context.phone || password === context.phone.replace(/^\+91/, ''))
  ) {
    return 'AUTH_PASSWORD_WEAK';
  }
  if (/^(.)\1+$/.test(password)) return 'AUTH_PASSWORD_WEAK'; // one repeated character
  if (COMMON_PASSWORDS.has(lower)) return 'AUTH_PASSWORD_BREACHED';
  return null;
}
