import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './http/errors';

/**
 * Opaque keyset cursors (FR-DISC-004, SRS §14.1). A cursor carries the sort
 * key of the last item and a fingerprint of the query it belongs to, so it
 * can't be replayed against different filters or sorts.
 */
export type SortKey = (string | number)[];

const cursorSchema = z
  .object({
    v: z.literal(1),
    q: z.string().max(32),
    k: z
      .array(z.union([z.string().max(64), z.number()]))
      .min(1)
      .max(8),
  })
  .strict();

/** Short stable fingerprint of whatever defines the list (sort, filters, query text). */
export const queryFingerprint = (parts: unknown) =>
  createHash('sha1').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);

export function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export function encodeCursor(context: string, key: SortKey): string {
  return Buffer.from(JSON.stringify({ v: 1, q: context, k: key })).toString('base64url');
}

/** Malformed, tampered or mismatched cursors are a VALIDATION_ERROR. */
export function decodeCursor(cursor: string, context: string): SortKey {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (parsed.q !== context) throw new Error('context mismatch');
    return parsed.k;
  } catch {
    throw new AppError('VALIDATION_ERROR', {
      message: 'This list has changed. Please reload it.',
      details: [{ path: 'cursor', code: 'INVALID_CURSOR', message: 'Invalid cursor' }],
    });
  }
}

/** Sorts by key, then returns the page after `cursor` and the next cursor. */
export function paginate<T>(
  items: { key: SortKey; value: T }[],
  options: { limit: number; cursor?: string | undefined; context: string },
): { page: T[]; nextCursor: string | null } {
  const sorted = [...items].sort((a, b) => compareKeys(a.key, b.key));
  const after = options.cursor ? decodeCursor(options.cursor, options.context) : null;
  const rest = after ? sorted.filter((i) => compareKeys(i.key, after) > 0) : sorted;
  const page = rest.slice(0, options.limit);
  const last = page.at(-1);
  return {
    page: page.map((p) => p.value),
    nextCursor:
      rest.length > options.limit && last ? encodeCursor(options.context, last.key) : null,
  };
}
