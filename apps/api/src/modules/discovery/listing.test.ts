import { describe, expect, it } from 'vitest';
import { geohash } from './geohash';
import {
  applyFilters,
  encodeCursor,
  paginate,
  recommendedScore,
  sortKey,
  type Entry,
} from './listing';

const base: Entry = {
  branchId: 'b',
  restaurantId: 'r',
  cuisineSlugs: ['biryani'],
  rating: 4.2,
  etaMax: 35,
  distanceM: 2000,
  priceForTwo: 50_000,
  deliveryCost: 2900,
  orders30d: 0,
  pureVeg: false,
  hasVeg: true,
  hasVegan: false,
  hasOffer: false,
  isOpen: true,
  affinity: false,
};
const e = (over: Partial<Entry>): Entry => ({ ...base, ...over });
const W = { rating: 0.35, eta: 0.25, popularity: 0.2, offer: 0.1, affinity: 0.1 };

describe('discovery filters (FR-DISC-002, FR-DISC-008)', () => {
  const list = [
    e({ branchId: 'a', cuisineSlugs: ['pizza'], rating: 4.6, pureVeg: true, hasVegan: true }),
    e({ branchId: 'b', cuisineSlugs: ['biryani'], rating: null, isOpen: false, priceForTwo: null }),
    e({
      branchId: 'c',
      cuisineSlugs: ['chinese', 'pizza'],
      etaMax: 60,
      deliveryCost: 4900,
      distanceM: 6000,
      hasVeg: false,
    }),
  ];
  const ids = (f: Parameters<typeof applyFilters>[1]) =>
    applyFilters(list, f).map((x) => x.branchId);

  it('ORs cuisines and ANDs everything else', () => {
    expect(ids({ cuisines: ['pizza'] })).toEqual(['a', 'c']);
    expect(ids({ cuisines: ['pizza'], maxEta: 40 })).toEqual(['a']);
  });
  it.each([
    [{ minRating: 4.5 }, ['a']],
    [{ maxDeliveryFee: 3000 }, ['a', 'b']],
    [{ priceMin: 40_000, priceMax: 60_000 }, ['a', 'c']],
    [{ pureVeg: true }, ['a']],
    [{ vegan: true }, ['a']],
    [{ openNow: true }, ['a', 'c']],
    [{ maxDistance: 5 }, ['a', 'b']],
    [{ vegOnly: true }, ['a', 'b']],
    [{ offers: true }, []],
  ])('%j', (filter, expected) => {
    expect(ids(filter)).toEqual(expected);
  });
});

describe('sorting and pagination (FR-DISC-003, 004, 011)', () => {
  it('scores rating, speed, popularity and affinity', () => {
    const fast = recommendedScore(e({ etaMax: 20 }), W, 0);
    const slow = recommendedScore(e({ etaMax: 80 }), W, 0);
    expect(fast).toBeGreaterThan(slow);
    expect(recommendedScore(e({ affinity: true }), W, 0)).toBeCloseTo(
      recommendedScore(e({}), W, 0) + 0.1,
    );
    expect(recommendedScore(e({ orders30d: 10 }), W, 10)).toBeCloseTo(
      recommendedScore(e({}), W, 10) + 0.2,
    );
  });

  it('puts closed branches last and pure-veg first when veg-only', () => {
    const open = sortKey(e({ branchId: 'o', distanceM: 9000 }), 'distance', false, 0);
    const closed = sortKey(
      e({ branchId: 'x', distanceM: 100, isOpen: false }),
      'distance',
      false,
      0,
    );
    const sorted = paginate(
      [
        { key: closed, value: 'closed' },
        { key: open, value: 'open' },
      ],
      { limit: 10, context: 'c' },
    );
    expect(sorted.page).toEqual(['open', 'closed']);
    const veg = sortKey(e({ pureVeg: true, distanceM: 9000 }), 'distance', true, 0);
    const mixed = sortKey(e({ distanceM: 100 }), 'distance', true, 0);
    expect(
      paginate(
        [
          { key: mixed, value: 'mixed' },
          { key: veg, value: 'veg' },
        ],
        { limit: 10, context: 'c' },
      ).page,
    ).toEqual(['veg', 'mixed']);
  });

  it('sorts cost both ways with unknown prices last', () => {
    const items = [
      e({ branchId: '1', priceForTwo: 30_000 }),
      e({ branchId: '2', priceForTwo: null }),
      e({ branchId: '3', priceForTwo: 90_000 }),
    ];
    const order = (sort: 'cost_asc' | 'cost_desc') =>
      paginate(
        items.map((x) => ({ key: sortKey(x, sort, false, 0), value: x.branchId })),
        { limit: 10, context: sort },
      ).page;
    expect(order('cost_asc')).toEqual(['1', '3', '2']);
    expect(order('cost_desc')).toEqual(['3', '1', '2']);
  });

  it('pages stably with ties broken by restaurant and branch', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      e({ restaurantId: `r${i}`, branchId: `b${i}` }),
    ).map((x) => ({
      key: sortKey(x, 'rating', false, 0),
      value: x.branchId,
    }));
    const first = paginate(items, { limit: 2, context: 'ctx' });
    expect(first.page).toEqual(['b0', 'b1']);
    const second = paginate(items, { limit: 2, context: 'ctx', cursor: first.nextCursor! });
    expect(second.page).toEqual(['b2', 'b3']);
    const third = paginate(items, { limit: 2, context: 'ctx', cursor: second.nextCursor! });
    expect(third).toEqual({ page: ['b4'], nextCursor: null });
  });

  it('rejects tampered cursors and cursors from another query', () => {
    const items = [{ key: sortKey(base, 'rating', false, 0), value: 1 }];
    expect(() => paginate(items, { limit: 1, context: 'ctx', cursor: 'not-a-cursor' })).toThrow(
      /reload/,
    );
    const other = encodeCursor('different', sortKey(base, 'rating', false, 0));
    expect(() => paginate(items, { limit: 1, context: 'ctx', cursor: other })).toThrow(/reload/);
  });
});

describe('geohash', () => {
  it('matches the reference encoding', () => {
    expect(geohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    expect(geohash(12.9352, 77.6245, 6)).toHaveLength(6);
  });
});
