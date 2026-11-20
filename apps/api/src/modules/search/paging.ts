import {
  compareKeys,
  decodeCursor,
  encodeCursor,
  queryFingerprint,
} from '../../platform/pagination';

/** Highest score first; ties by ID. Cursor = last (−score, id). */
export function paginateByScore<T>(
  items: { score: number; id: string; value: T }[],
  limit: number,
  context: unknown,
  cursor?: string,
): { page: T[]; nextCursor: string | null } {
  const keyed = items
    .map((i) => ({
      key: [-Math.round(i.score * 1e6) / 1e6, i.id] as (string | number)[],
      value: i.value,
    }))
    .sort((a, b) => compareKeys(a.key, b.key));
  const fingerprint = queryFingerprint(context);
  const after = cursor ? decodeCursor(cursor, fingerprint) : null;
  const rest = after ? keyed.filter((i) => compareKeys(i.key, after) > 0) : keyed;
  const page = rest.slice(0, limit);
  const last = page.at(-1);
  return {
    page: page.map((p) => p.value),
    nextCursor: rest.length > limit && last ? encodeCursor(fingerprint, last.key) : null,
  };
}
