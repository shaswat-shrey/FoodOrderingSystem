import type { PrismaClient } from '@fos/db';
import type { DiscoveryListQuery } from '@fos/validation';
import type { Redis } from 'ioredis';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { queryFingerprint } from '../../platform/pagination';
import type { Logger } from '../../platform/logger';
import {
  branchCard,
  favoriteRestaurantIds,
  isListed,
  toCard,
  type BranchRecord,
  type BranchRepository,
  type DeliveryInfo,
  type ItemCard,
  type MenuService,
  type ServiceabilityService,
} from '../catalog';
import type { SettingsService } from '../config';
import type { LatLng } from '../geo';
import { geohash } from './geohash';
import {
  applyFilters,
  paginate,
  recommendedScore,
  sortKey,
  type Entry,
  type Filters,
} from './listing';

export type Card = ReturnType<typeof branchCard>;

interface Candidate {
  entry: Entry;
  branch: BranchRecord;
  info: DeliveryInfo;
  card: Card;
}

const SECTION_LIMIT = 15; // FR-DISC-005
const HOME_TTL_SECONDS = 300; // FR-DISC-005: 5 minutes per geohash-6 cell
const COUNTED_STATUSES = [
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'DELIVERED',
] as const;

export const BUILT_IN_COLLECTIONS: Record<string, string> = {
  recommended: 'Recommended for you',
  popular: 'Popular near you',
  'top-rated': 'Top rated',
  new: 'Newly added',
  'free-delivery': 'Free delivery',
  offers: 'Great offers',
};

/** FR-DISC-001…012 over PostGIS candidates (BR-GEO-001 a–c, e). */
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly branches: BranchRepository,
    private readonly serviceability: ServiceabilityService,
    private readonly menus: MenuService,
    private readonly settings: SettingsService,
    private readonly cache: Redis,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /**
   * Serviceable branches for a point, one per restaurant (open beats closed,
   * then nearest). Throws LOCATION_NOT_SERVICEABLE outside active zones.
   */
  async candidates(
    point: LatLng,
    userId: string | null,
  ): Promise<{ zone: { id: string; name: string }; list: Candidate[] }> {
    const zone = await this.serviceability.zoneAt(point);
    if (!zone || zone.status !== 'ACTIVE') {
      const reason = zone ? 'ZONE_SUSPENDED' : 'OUTSIDE_ZONE';
      throw new AppError('LOCATION_NOT_SERVICEABLE', {
        message: zone
          ? 'Deliveries are paused in this area right now.'
          : "We're not in your area yet.",
        details: [{ path: 'lat', code: reason, message: reason }],
      });
    }
    const now = this.clock.now();
    const rows = await this.prisma.$queryRaw<{ id: string; distance_m: number }[]>`
      WITH p AS (SELECT ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography AS g)
      SELECT b.id, ST_Distance(b.location, p.g) AS distance_m
      FROM branches b
      JOIN restaurants r ON r.id = b.restaurant_id
      JOIN zones z ON z.id = b.zone_id, p
      WHERE b.deleted_at IS NULL AND b.status = 'ACTIVE' AND b.zone_id = ${zone.id}::uuid
        AND r.onboarding_status = 'APPROVED' AND r.status = 'ACTIVE'
        AND ST_DWithin(b.location, p.g, LEAST(b.delivery_radius_m, z.max_delivery_radius_m))`;
    if (rows.length === 0) return { zone: { id: zone.id, name: zone.name }, list: [] };

    const ids = rows.map((r) => r.id);
    const distance = new Map(rows.map((r) => [r.id, Number(r.distance_m)]));
    const [records, flags, orders, affinity, favorites] = await Promise.all([
      this.branches.load(ids, now),
      this.prisma.$queryRaw<{ restaurant_id: string; has_veg: boolean; has_vegan: boolean }[]>`
        SELECT f.restaurant_id,
               bool_or(f.dietary_marker = 'VEG') AS has_veg,
               bool_or(t.tag IS NOT NULL) AS has_vegan
        FROM food_items f
        JOIN branches b ON b.restaurant_id = f.restaurant_id AND b.id = ANY(${ids}::uuid[])
        LEFT JOIN food_item_tags t ON t.food_item_id = f.id AND t.tag = 'VEGAN'
        WHERE f.deleted_at IS NULL AND NOT f.is_hidden
        GROUP BY f.restaurant_id`,
      this.prisma.order.groupBy({
        by: ['branchId'],
        where: {
          branchId: { in: ids },
          status: { in: [...COUNTED_STATUSES] },
          placedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
        },
        _count: { _all: true },
      }),
      userId ? this.orderedRestaurantIds(userId, 50) : Promise.resolve([] as string[]),
      userId ? this.favoritesFor(userId) : Promise.resolve(new Set<string>()),
    ]);
    const flagBy = new Map(flags.map((f) => [f.restaurant_id, f]));
    const ordersBy = new Map(orders.map((o) => [o.branchId, o._count._all]));
    const ordered = new Set(affinity);

    const all: Candidate[] = [];
    for (const branch of records.values()) {
      if (!isListed(branch)) continue;
      const straight = distance.get(branch.id)!;
      const info = await this.serviceability.deliveryInfo(branch, point, straight, zone.id);
      if (info.reason === 'OUTSIDE_RADIUS' || info.reason === 'OUTSIDE_ZONE') continue;
      const f = flagBy.get(branch.restaurantId);
      const isFavorite = favorites.has(branch.restaurantId);
      const card = branchCard(branch, { delivery: info, isFavorite });
      all.push({
        branch,
        info,
        card,
        entry: {
          branchId: branch.id,
          restaurantId: branch.restaurantId,
          cuisineSlugs: branch.restaurant.cuisines.map((c) => c.cuisine.slug),
          rating: card.rating.average,
          etaMax: info.eta.maxMinutes,
          distanceM: straight,
          priceForTwo: branch.priceForTwo,
          deliveryCost: info.deliveryFeeAmount + info.surge.amount,
          orders30d: ordersBy.get(branch.id) ?? 0,
          pureVeg: branch.restaurant.pureVeg,
          hasVeg: f?.has_veg ?? false,
          hasVegan: f?.has_vegan ?? false,
          hasOffer: false, // promotions arrive in Phase 6
          isOpen: branch.computed.acceptingOrders,
          affinity: isFavorite || ordered.has(branch.restaurantId),
        },
      });
    }
    // One branch per brand: open first, then nearest.
    const best = new Map<string, Candidate>();
    for (const c of all) {
      const current = best.get(c.entry.restaurantId);
      if (
        !current ||
        (c.entry.isOpen && !current.entry.isOpen) ||
        (c.entry.isOpen === current.entry.isOpen && c.entry.distanceM < current.entry.distanceM)
      ) {
        best.set(c.entry.restaurantId, c);
      }
    }
    return { zone: { id: zone.id, name: zone.name }, list: [...best.values()] };
  }

  private async favoritesFor(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.favoriteRestaurant.findMany({
      where: { userId },
      select: { restaurantId: true },
    });
    return new Set(rows.map((r) => r.restaurantId));
  }

  /** Restaurants from the customer's most recent delivered orders, newest first. */
  private async orderedRestaurantIds(userId: string, take: number): Promise<string[]> {
    const orders = await this.prisma.order.findMany({
      where: { userId, status: 'DELIVERED' },
      orderBy: { deliveredAt: 'desc' },
      take,
      select: { restaurantId: true },
    });
    return [...new Set(orders.map((o) => o.restaurantId))];
  }

  private async rank(list: Candidate[], sort: DiscoveryListQuery['sort'], vegOnly: boolean) {
    const weights = await this.settings.get('discovery.weights');
    const maxOrders = Math.max(0, ...list.map((c) => c.entry.orders30d));
    return list.map((c) => ({
      key: sortKey(c.entry, sort, vegOnly, recommendedScore(c.entry, weights, maxOrders)),
      value: c,
    }));
  }

  /** API-DISC-001 / 005 */
  async list(query: DiscoveryListQuery, userId: string | null) {
    const { lat, lng, sort, cursor, limit, ...filters } = query;
    const { zone, list } = await this.candidates({ lat, lng }, userId);
    const context = queryFingerprint({ sort, filters });
    const byEntry = new Map(list.map((c) => [c.entry, c]));
    const filtered = applyFilters(
      list.map((c) => c.entry),
      filters as Filters,
    ).map((e) => byEntry.get(e)!);
    const ranked = await this.rank(filtered, sort, filters.vegOnly ?? false);
    const { page, nextCursor } = paginate(ranked, {
      limit,
      context,
      ...(cursor ? { cursor } : {}),
    });
    return { zone, results: page.map((c) => c.card), nextCursor };
  }

  /** API-DISC-003: built-in and admin-curated collections (FR-DISC-005). */
  async collection(
    slug: string,
    point: LatLng,
    opts: { vegOnly: boolean; limit: number; cursor?: string },
    userId: string | null,
  ) {
    const { list } = await this.candidates(point, userId);
    const pool = opts.vegOnly ? list.filter((c) => c.entry.hasVeg) : list;
    const now = this.clock.now();
    let title: string;
    let picked: { key: (string | number)[]; value: Candidate }[];

    if (BUILT_IN_COLLECTIONS[slug]) {
      title = BUILT_IN_COLLECTIONS[slug]!;
      const subset = {
        recommended: pool,
        popular: pool.filter((c) => c.entry.orders30d > 0),
        'top-rated': pool.filter(
          (c) => (c.card.rating.average ?? 0) >= 4.2 && c.card.rating.count >= 50,
        ),
        new: pool.filter(
          (c) =>
            c.branch.restaurant.approvedAt &&
            now.getTime() - c.branch.restaurant.approvedAt.getTime() <= 30 * 86_400_000,
        ),
        'free-delivery': pool.filter((c) => c.entry.deliveryCost === 0),
        offers: pool.filter((c) => c.entry.hasOffer),
      }[slug]!;
      picked = await this.rank(
        subset,
        slug === 'popular' ? 'popularity' : 'recommended',
        opts.vegOnly,
      );
    } else {
      const collection = await this.prisma.collection.findFirst({
        where: { slug, isActive: true },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      if (!collection)
        throw new AppError('NOT_FOUND', { message: "We couldn't find that collection." });
      title = collection.title;
      const position = new Map(collection.items.map((i) => [i.restaurantId, i.position]));
      picked = pool
        .filter((c) => position.has(c.entry.restaurantId))
        .map((c) => ({
          key: [
            c.entry.isOpen ? 0 : 1,
            0,
            position.get(c.entry.restaurantId)!,
            c.entry.restaurantId,
            c.entry.branchId,
          ],
          value: c,
        }));
    }
    const { page, nextCursor } = paginate(picked, {
      limit: opts.limit,
      context: queryFingerprint(['collection', slug, opts.vegOnly]),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
    return { slug, title, results: page.map((c) => c.card), nextCursor };
  }

  /** API-DISC-004: cuisines available here, most restaurants first. */
  async cuisines(point: LatLng, vegOnly: boolean) {
    const { list } = await this.candidates(point, null);
    const counts = new Map<string, { slug: string; name: string; restaurantCount: number }>();
    for (const c of list) {
      if (vegOnly && !c.entry.hasVeg) continue;
      for (const { cuisine } of c.branch.restaurant.cuisines) {
        const row = counts.get(cuisine.slug) ?? {
          slug: cuisine.slug,
          name: cuisine.name,
          restaurantCount: 0,
        };
        row.restaurantCount += 1;
        counts.set(cuisine.slug, row);
      }
    }
    return [...counts.values()].sort(
      (a, b) => b.restaurantCount - a.restaurantCount || a.name.localeCompare(b.name),
    );
  }

  /** API-DISC-010: filter values that actually match something here. */
  async facets(point: LatLng) {
    const { list } = await this.candidates(point, null);
    const count = (pred: (e: Entry) => boolean) => list.filter((c) => pred(c.entry)).length;
    const bands = [
      { key: 'under-300', label: 'Under ₹300', min: 0, max: 29_999 },
      { key: '300-600', label: '₹300 – ₹600', min: 30_000, max: 60_000 },
      { key: 'over-600', label: 'Over ₹600', min: 60_001, max: null },
    ];
    return {
      total: list.length,
      cuisines: await this.cuisines(point, false),
      ratings: [3.5, 4, 4.5].map((r) => ({
        minRating: r,
        count: count((e) => (e.rating ?? 0) >= r),
      })),
      priceForTwo: bands.map((b) => ({
        ...b,
        count: count(
          (e) =>
            e.priceForTwo !== null &&
            e.priceForTwo >= b.min &&
            (b.max === null || e.priceForTwo <= b.max),
        ),
      })),
      pureVeg: count((e) => e.pureVeg),
      vegan: count((e) => e.hasVegan),
      openNow: count((e) => e.isOpen),
      freeDelivery: count((e) => e.deliveryCost === 0),
      offers: count((e) => e.hasOffer),
    };
  }

  /** Dishes from open, serviceable branches (API-DISC-006, 011). */
  async items(
    point: LatLng,
    pick: (item: ItemCard, categoryName: string) => boolean,
    vegOnly: boolean,
    limit: number,
  ) {
    const { list } = await this.candidates(point, null);
    const now = this.clock.now();
    const results: {
      item: ItemCard;
      branch: { branchId: string; restaurantName: string; eta: DeliveryInfo['eta'] };
    }[] = [];
    const open = list
      .filter((c) => c.entry.isOpen)
      .sort((a, b) => a.entry.distanceM - b.entry.distanceM);
    for (const c of open) {
      const raw = await this.menus.raw(c.branch);
      const categories = new Map(raw.categories.map((x) => [x.id, x.name]));
      for (const item of raw.items) {
        if (vegOnly && item.dietaryMarker !== 'VEG') continue;
        const card = toCard(item, { acceptingOrders: true, opensAt: null }, now);
        if (!card.available || !pick(card, categories.get(item.categoryId) ?? '')) continue;
        results.push({
          item: card,
          branch: {
            branchId: c.branch.id,
            restaurantName: c.branch.restaurant.brandName,
            eta: c.info.eta,
          },
        });
      }
    }
    return results.slice(0, limit);
  }

  /** API-DISC-008: active banners for the zone; internal links only (FR-DISC-006). */
  async banners(point: LatLng) {
    const zone = await this.serviceability.zoneAt(point);
    const now = this.clock.now();
    const rows = await this.prisma.banner.findMany({
      where: {
        deletedAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
        OR: [{ zoneId: null }, ...(zone ? [{ zoneId: zone.id }] : [])],
      },
      orderBy: { position: 'asc' },
    });
    return rows
      .filter((b) => b.targetRoute.startsWith('/') && !b.targetRoute.startsWith('//'))
      .map((b) => ({
        id: b.id,
        title: b.title,
        imageUrl: null as string | null,
        targetRoute: b.targetRoute,
      }));
  }

  /** API-DISC-009 / FR-DISC-012: from the last 5 delivered orders, if serviceable here. */
  async orderAgain(point: LatLng, userId: string) {
    const recent = (await this.orderedRestaurantIds(userId, 50)).slice(0, 5);
    if (recent.length === 0) return [];
    const { list } = await this.candidates(point, userId);
    return recent.flatMap((id) =>
      list.filter((c) => c.entry.restaurantId === id).map((c) => c.card),
    );
  }

  /** API-DISC-002: home sections, cached per geohash-6 cell; personal parts added per request. */
  async home(point: LatLng, vegOnly: boolean, userId: string | null) {
    const key = `home:v1:${geohash(point.lat, point.lng, 6)}:${vegOnly ? 1 : 0}`;
    let home: Awaited<ReturnType<DiscoveryService['buildHome']>> | null = null;
    try {
      const hit = await this.cache.get(key);
      if (hit) home = JSON.parse(hit);
    } catch (error) {
      this.logger.warn({ err: error }, 'home cache read failed');
    }
    if (!home) {
      home = await this.buildHome(point, vegOnly);
      await this.cache
        .set(key, JSON.stringify(home), 'EX', HOME_TTL_SECONDS)
        .catch((error: unknown) => {
          this.logger.warn({ err: error }, 'home cache write failed');
        });
    }
    if (!userId) return { ...home, orderAgain: [] as Card[] };
    const favorites = await favoriteRestaurantIds(
      this.prisma,
      userId,
      home.sections.flatMap((s) =>
        s.type === 'restaurants' ? s.restaurants.map((r) => r.restaurantId) : [],
      ),
    );
    return {
      ...home,
      sections: home.sections.map((s) =>
        s.type === 'restaurants'
          ? {
              ...s,
              restaurants: s.restaurants.map((r) => ({
                ...r,
                isFavorite: favorites.has(r.restaurantId),
              })),
            }
          : s,
      ),
      orderAgain: await this.orderAgain(point, userId),
    };
  }

  private async buildHome(point: LatLng, vegOnly: boolean) {
    const { zone } = await this.candidates(point, null);
    const restaurantSections = await Promise.all(
      ['featured', ...Object.keys(BUILT_IN_COLLECTIONS)].map(async (slug) => {
        try {
          const c = await this.collection(slug, point, { vegOnly, limit: SECTION_LIMIT }, null);
          return {
            key: slug,
            title: c.title,
            type: 'restaurants' as const,
            restaurants: c.results,
          };
        } catch (error) {
          if (error instanceof AppError && error.code === 'NOT_FOUND') return null; // no curated "featured" set
          throw error;
        }
      }),
    );
    const itemSections = [
      {
        key: 'todays-specials',
        title: "Today's specials",
        items: await this.items(point, (i) => i.isTodaysSpecial, vegOnly, SECTION_LIMIT),
      },
      {
        key: 'bestsellers',
        title: 'Best-selling dishes',
        items: await this.items(point, (i) => i.isBestseller, vegOnly, SECTION_LIMIT),
      },
      // FR-DISC-005 "Trending dishes" needs order growth data (Phase 7).
    ].map((s) => ({ ...s, type: 'items' as const }));
    return {
      zone,
      banners: await this.banners(point),
      cuisines: (await this.cuisines(point, vegOnly)).slice(0, 12),
      sections: [
        ...restaurantSections.filter(
          (s): s is NonNullable<typeof s> => s !== null && s.restaurants.length > 0,
        ),
        ...itemSections.filter((s) => s.items.length > 0),
      ],
    };
  }
}
