import type { DiscoveryListQuery } from '@fos/validation';
import type { SortKey } from '../../platform/pagination';

export { compareKeys, decodeCursor, encodeCursor, paginate } from '../../platform/pagination';

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

export type { SortKey };

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
