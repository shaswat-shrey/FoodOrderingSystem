import { z } from 'zod';
import type { DiscoveryListQuery } from '@fos/validation';
import { AppError } from '../../platform/http/errors';

/** What filters and sorts need to know about one serviceable branch. */
export interface Entry {
  branchId: string;
  restaurantId: string;
  cuisineSlugs: string[];
  rating: number | null;
  etaMax: number;
  distanceM: number;
  priceForTwo: number | null;
  /** Delivery fee + active surge, paise. */
  deliveryCost: number;
  orders30d: number;
  pureVeg: boolean;
  hasVeg: boolean;
  hasVegan: boolean;
  hasOffer: boolean;
  isOpen: boolean;
  /** Favourite or ordered before (signed-in only). */
  affinity: boolean;
}

export interface Weights {
  rating: number;
  eta: number;
  popularity: number;
  offer: number;
  affinity: number;
}

export type Filters = Omit<DiscoveryListQuery, 'lat' | 'lng' | 'sort' | 'cursor' | 'limit'>;

/** FR-DISC-002 (AND between filters, OR within cuisines) and FR-DISC-008. */
export function applyFilters(entries: Entry[], f: Filters): Entry[] {
  return entries.filter(
    (e) =>
      (!f.cuisines || f.cuisines.some((c) => e.cuisineSlugs.includes(c))) &&
      (f.minRating === undefined || (e.rating !== null && e.rating >= f.minRating)) &&
      (f.maxEta === undefined || e.etaMax <= f.maxEta) &&
      (f.maxDeliveryFee === undefined || e.deliveryCost <= f.maxDeliveryFee) &&
      (f.priceMin === undefined || (e.priceForTwo !== null && e.priceForTwo >= f.priceMin)) &&
      (f.priceMax === undefined || (e.priceForTwo !== null && e.priceForTwo <= f.priceMax)) &&
      (!f.offers || e.hasOffer) &&
      (!f.pureVeg || e.pureVeg) &&
      (!f.vegan || e.hasVegan) &&
      (!f.openNow || e.isOpen) &&
      (f.maxDistance === undefined || e.distanceM <= f.maxDistance * 1000) &&
      (!f.vegOnly || e.hasVeg),
  );
}

/** FR-DISC-011: weighted score in [0, Σweights]; unrated places count at the 4.0 prior. */
export function recommendedScore(e: Entry, w: Weights, maxOrders: number): number {
  return (
    w.rating * ((e.rating ?? 4) / 5) +
    w.eta * (1 - Math.min(e.etaMax, 90) / 90) +
    w.popularity * (maxOrders > 0 ? e.orders30d / maxOrders : 0) +
    w.offer * (e.hasOffer ? 1 : 0) +
    w.affinity * (e.affinity ? 1 : 0)
  );
}

type SortKey = (string | number)[];

/**
 * FR-DISC-003: closed/paused branches always trail open ones (FR-DISC-001 step 3);
 * with veg-only, pure-veg restaurants come first (FR-DISC-008); ties break by
 * restaurant then branch ID so pages are stable.
 */
export function sortKey(
  e: Entry,
  sort: DiscoveryListQuery['sort'],
  vegOnly: boolean,
  score: number,
): SortKey {
  const NONE = Number.MAX_SAFE_INTEGER;
  const primary = {
    recommended: -score,
    rating: -(e.rating ?? 0),
    eta: e.etaMax,
    distance: e.distanceM,
    cost_asc: e.priceForTwo ?? NONE,
    cost_desc: e.priceForTwo === null ? NONE : -e.priceForTwo,
    popularity: -e.orders30d,
  }[sort];
  return [e.isOpen ? 0 : 1, vegOnly && !e.pureVeg ? 1 : 0, primary, e.restaurantId, e.branchId];
}

export function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

const cursorSchema = z
  .object({
    v: z.literal(1),
    /** Sort + filters the cursor was made for: reuse with others is rejected. */
    q: z.string().max(64),
    k: z.array(z.union([z.string().max(64), z.number()])).length(5),
  })
  .strict();

export function encodeCursor(context: string, key: SortKey): string {
  return Buffer.from(JSON.stringify({ v: 1, q: context, k: key })).toString('base64url');
}

/** FR-DISC-004: malformed or mismatched cursors are a VALIDATION_ERROR. */
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

/** Sorts, then returns the page after `cursor` and the cursor for the next page. */
export function paginate<T>(
  items: { key: SortKey; value: T }[],
  options: { limit: number; cursor?: string; context: string },
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
