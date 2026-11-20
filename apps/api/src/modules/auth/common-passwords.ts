import list from './data/common-passwords.json' with { type: 'json' };

/**
 * BR-AUTH-001 breached-password list (D-4, approved 2026-11-20).
 *
 * Source: the UK NCSC "100k most used passwords" list (Have I Been Pwned data),
 * as published in SecLists (MIT): Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt.
 * Only entries of 8–128 characters are stored (shorter ones already fail the
 * length rule), lowercased and de-duplicated: 46,487 entries. The check is
 * case-insensitive. Bundled into the build, so no file is read at runtime.
 *
 * To refresh, download the source file and run apps/api/scripts/build-common-passwords.mjs.
 */
/** Service-specific words (NIST SP 800-63B context words) and a few not in the NCSC list. */
const CONTEXT_WORDS = ['foodorder', 'foodordersystem', 'test@123', 'pa$$w0rd', 'fortnite'];

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  ...(list as string[]),
  ...CONTEXT_WORDS,
]);
