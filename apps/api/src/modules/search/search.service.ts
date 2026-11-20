import type { PrismaClient } from '@fos/db';
import type { SearchQuery } from '@fos/validation';
import type { Clock } from '../../platform/clock';
import { toCard, type ItemCard, type MenuService } from '../catalog';
import type { SettingsService } from '../config';
import type { DiscoveryService } from '../discovery';
import type { LatLng } from '../geo';
import { paginateByScore } from './paging';

/** Letters and digits only, so user input can never inject tsquery operators. */
export function searchTokens(q: string): string[] {
  return q
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 8);
}

/** Prefix query: every word must match the start of a word ("chick dum" → chick:* & dum:*). */
export const prefixQuery = (tokens: string[]) => tokens.map((t) => `${t}:*`).join(' & ');

const TRIGRAM_THRESHOLD = 0.3; // FR-SRCH-003 (word similarity: a short query against a longer name)
const FUZZY_WHEN_FEWER_THAN = 5;

interface Hit {
  id: string;
  score: number;
}

/** FR-SRCH-001…008, ADR-009 (PostgreSQL full text + trigram). */
export class SearchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly discovery: DiscoveryService,
    private readonly menus: MenuService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  async search(query: SearchQuery, userId: string | null) {
    const tokens = searchTokens(query.q);
    const point = { lat: query.lat, lng: query.lng };
    const { list } = await this.discovery.candidates(point, userId);
    if (userId) await this.remember(userId, query.q);
    if (tokens.length === 0 || list.length === 0)
      return { restaurants: [], dishes: [], cuisines: [], nextCursor: null };

    const restaurantIds = list.map((c) => c.entry.restaurantId);
    const ts = prefixQuery(tokens);
    const text = tokens.join(' ');

    const [restaurantHits, dishHits] = await Promise.all([
      query.type === 'dish'
        ? Promise.resolve([] as Hit[])
        : this.restaurantHits(restaurantIds, ts, text),
      query.type === 'restaurant'
        ? Promise.resolve([] as Hit[])
        : this.dishHits(restaurantIds, ts, text),
    ]);

    // Restaurants: text score plus rating and nearness (FR-SRCH-002).
    const byRestaurant = new Map(list.map((c) => [c.entry.restaurantId, c]));
    const restaurants = restaurantHits
      .map((h) => ({ hit: h, c: byRestaurant.get(h.id)! }))
      .filter(
        ({ c }) =>
          (!query.vegOnly || c.entry.hasVeg) &&
          (query.minRating === undefined || (c.entry.rating ?? 0) >= query.minRating),
      )
      .filter(({ c }) => query.maxEta === undefined || c.entry.etaMax <= query.maxEta)
      .map(({ hit, c }) => ({
        score:
          hit.score +
          0.2 * ((c.entry.rating ?? 4) / 5) -
          0.02 * (c.entry.distanceM / 1000) +
          (c.entry.isOpen ? 0.5 : 0),
        id: c.entry.branchId,
        value: c.card,
      }));

    // Dishes: resolved against the serving branch's live menu (availability, price).
    const now = this.clock.now();
    const dishes: {
      score: number;
      id: string;
      value: { item: ItemCard; branch: { branchId: string; restaurantName: string; eta: unknown } };
    }[] = [];
    const itemRestaurant = new Map(
      (
        await this.prisma.foodItem.findMany({
          where: { id: { in: dishHits.map((d) => d.id) } },
          select: { id: true, restaurantId: true },
        })
      ).map((r) => [r.id, r.restaurantId]),
    );
    const scoreBy = new Map(dishHits.map((d) => [d.id, d.score]));
    const grouped = new Map<string, string[]>();
    for (const d of dishHits) {
      const r = itemRestaurant.get(d.id);
      if (r) grouped.set(r, [...(grouped.get(r) ?? []), d.id]);
    }
    for (const [restaurantId, itemIds] of grouped) {
      const c = byRestaurant.get(restaurantId);
      if (!c) continue;
      if (query.minRating !== undefined && (c.entry.rating ?? 0) < query.minRating) continue;
      if (query.maxEta !== undefined && c.entry.etaMax > query.maxEta) continue;
      const raw = await this.menus.raw(c.branch);
      for (const item of raw.items.filter((i) => itemIds.includes(i.id))) {
        if (query.vegOnly && item.dietaryMarker !== 'VEG') continue;
        const card = toCard(
          item,
          {
            acceptingOrders: c.branch.computed.acceptingOrders,
            opensAt: c.branch.computed.opensAt,
          },
          now,
        );
        if (query.maxPrice !== undefined && card.priceAmount > query.maxPrice) continue;
        dishes.push({
          score:
            scoreBy.get(item.id)! + (card.available ? 0.5 : 0) - 0.02 * (c.entry.distanceM / 1000),
          id: item.id,
          value: {
            item: card,
            branch: {
              branchId: c.branch.id,
              restaurantName: c.branch.restaurant.brandName,
              eta: c.info.eta,
            },
          },
        });
      }
    }

    const cuisines =
      query.type === 'all' && !query.cursor ? await this.cuisineMatches(point, tokens) : [];
    // The cursor continues the restaurant list (type=restaurant) or the dish list (type=dish/all).
    const context = [
      'search',
      query.type,
      text,
      query.vegOnly,
      query.minRating,
      query.maxEta,
      query.maxPrice,
    ];
    if (query.type === 'restaurant') {
      const r = paginateByScore(restaurants, query.limit, context, query.cursor);
      return { restaurants: r.page, dishes: [], cuisines, nextCursor: r.nextCursor };
    }
    const d = paginateByScore(dishes, query.limit, context, query.cursor);
    return {
      restaurants: query.cursor ? [] : top(restaurants, 10),
      dishes: d.page,
      cuisines,
      nextCursor: d.nextCursor,
    };
  }

  private async restaurantHits(ids: string[], ts: string, text: string): Promise<Hit[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; score: number }[]>`
      WITH q AS (SELECT to_tsquery('simple', unaccent(${ts})) AS tq, unaccent(${text}) AS t)
      SELECT r.id,
        ts_rank(r.search_vector || setweight(to_tsvector('simple', unaccent(coalesce(cz.names, ''))), 'B'), q.tq)
        + word_similarity(q.t, unaccent(r.brand_name))
        + CASE WHEN unaccent(lower(r.brand_name)) LIKE q.t || '%' THEN 1 ELSE 0 END AS score
      FROM restaurants r CROSS JOIN q
      LEFT JOIN LATERAL (
        SELECT string_agg(c.name || ' ' || c.slug, ' ') AS names
        FROM restaurant_cuisines rc JOIN cuisines c ON c.id = rc.cuisine_id WHERE rc.restaurant_id = r.id
      ) cz ON true
      WHERE r.id = ANY(${ids}::uuid[])
        AND (r.search_vector || to_tsvector('simple', unaccent(coalesce(cz.names, ''))) @@ q.tq
             OR word_similarity(q.t, unaccent(r.brand_name)) >= ${TRIGRAM_THRESHOLD})`;
    return rows.map((r) => ({ id: r.id, score: Number(r.score) }));
  }

  /** Full text first; trigram typo matches only when that finds too little (FR-SRCH-003). */
  private async dishHits(ids: string[], ts: string, text: string): Promise<Hit[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; score: number; fts: boolean }[]>`
      WITH q AS (SELECT to_tsquery('simple', unaccent(${ts})) AS tq, unaccent(${text}) AS t)
      SELECT f.id,
        (f.search_vector || setweight(to_tsvector('simple', unaccent(mc.name)), 'B')) @@ q.tq AS fts,
        ts_rank(f.search_vector || setweight(to_tsvector('simple', unaccent(mc.name)), 'B'), q.tq)
        + word_similarity(q.t, unaccent(f.name))
        + CASE WHEN unaccent(lower(f.name)) LIKE q.t || '%' THEN 1 ELSE 0 END AS score
      FROM food_items f
      JOIN menu_categories mc ON mc.id = f.category_id AND mc.deleted_at IS NULL AND mc.is_active
      CROSS JOIN q
      WHERE f.restaurant_id = ANY(${ids}::uuid[]) AND f.deleted_at IS NULL AND NOT f.is_hidden
        AND ((f.search_vector || to_tsvector('simple', unaccent(mc.name))) @@ q.tq
             OR word_similarity(q.t, unaccent(f.name)) >= ${TRIGRAM_THRESHOLD})
      ORDER BY score DESC
      LIMIT 200`;
    const exact = rows.filter((r) => r.fts);
    const chosen = exact.length >= FUZZY_WHEN_FEWER_THAN ? exact : rows;
    return chosen.map((r) => ({ id: r.id, score: Number(r.score) }));
  }

  private async cuisineMatches(point: LatLng, tokens: string[]) {
    const available = await this.discovery.cuisines(point, false);
    return available
      .filter((c) => tokens.every((t) => c.name.toLowerCase().includes(t) || c.slug.includes(t)))
      .slice(0, 5);
  }

  /** API-SRCH-002: up to 8 mixed suggestions for a prefix (FR-SRCH-004). */
  async suggestions(q: string, point: LatLng) {
    const tokens = searchTokens(q);
    if (tokens.length === 0) return [];
    const { list } = await this.discovery.candidates(point, null);
    if (list.length === 0) return [];
    const ids = list.map((c) => c.entry.restaurantId);
    const ts = prefixQuery(tokens);
    const text = tokens.join(' ');
    const [restaurants, dishes, cuisines] = await Promise.all([
      this.restaurantHits(ids, ts, text),
      this.dishHits(ids, ts, text),
      this.cuisineMatches(point, tokens),
    ]);
    const byRestaurant = new Map(list.map((c) => [c.entry.restaurantId, c]));
    const names = new Map(
      (
        await this.prisma.foodItem.findMany({
          where: { id: { in: dishes.slice(0, 30).map((d) => d.id) } },
          select: { id: true, name: true },
        })
      ).map((d) => [d.id, d.name]),
    );
    const dishNames = [
      ...new Set(
        dishes
          .slice(0, 30)
          .map((d) => names.get(d.id))
          .filter((n): n is string => Boolean(n)),
      ),
    ];
    return [
      ...restaurants
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .map((r) => ({
          type: 'restaurant' as const,
          text: byRestaurant.get(r.id)!.branch.restaurant.brandName,
          branchId: byRestaurant.get(r.id)!.branch.id,
        })),
      ...cuisines
        .slice(0, 2)
        .map((c) => ({ type: 'cuisine' as const, text: c.name, slug: c.slug })),
      ...dishNames.slice(0, 4).map((name) => ({ type: 'dish' as const, text: name })),
    ].slice(0, 8);
  }

  /* --------------------------- history (FR-SRCH-005) --------------------------- */

  private async remember(userId: string, q: string): Promise<void> {
    const limit = await this.settings.get('search.historyLimit');
    if (limit === 0) return;
    const normalized = searchTokens(q).join(' ').slice(0, 100);
    if (!normalized) return;
    await this.prisma.$transaction([
      this.prisma.searchHistory.deleteMany({ where: { userId, normalized } }),
      this.prisma.searchHistory.create({ data: { userId, query: q.slice(0, 100), normalized } }),
    ]);
    const stale = await this.prisma.searchHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: limit,
      select: { id: true },
    });
    if (stale.length)
      await this.prisma.searchHistory.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }

  async history(userId: string) {
    return this.prisma.searchHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, query: true, createdAt: true },
    });
  }

  async forget(userId: string, id?: string): Promise<void> {
    await this.prisma.searchHistory.deleteMany({ where: { userId, ...(id ? { id } : {}) } });
  }

  /** API-SRCH-003: top queries in the zone over 24 h with ≥ 20 distinct users (FR-SRCH-006). */
  async trending(point: LatLng) {
    const { zone } = await this.discovery.candidates(point, null);
    const since = new Date(this.clock.now().getTime() - 86_400_000);
    const rows = await this.prisma.searchQueryStat.groupBy({
      by: ['normalized'],
      where: { zoneId: zone.id, hour: { gte: since } },
      _sum: { count: true, distinctUsers: true },
    });
    return rows
      .filter((r) => (r._sum.distinctUsers ?? 0) >= 20)
      .sort((a, b) => (b._sum.count ?? 0) - (a._sum.count ?? 0))
      .slice(0, 10)
      .map((r) => ({ query: r.normalized, count: r._sum.count ?? 0 }));
  }
}

const top = <T>(scored: { score: number; value: T }[], n: number) =>
  [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((s) => s.value);
