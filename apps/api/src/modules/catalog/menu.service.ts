import type { DietaryMarker, PrismaClient } from '@fos/db';
import type { Redis } from 'ioredis';
import { softRedis } from '../../platform/redis';
import type { Logger } from '../../platform/logger';
import type { BranchRecord } from './branch-repository';

/* ----------------------------------------------------------------------------
 * Raw menu: everything that only changes when the restaurant edits its menu or
 * availability (each such write bumps branches.menu_version, FR-MENUC-008).
 * Cached as JSON per branch + version; time-dependent state is resolved per request.
 * ------------------------------------------------------------------------- */

interface RawAvailability {
  isAvailable: boolean;
  unavailableUntil: string | null;
}

interface RawOption {
  id: string;
  name: string;
  priceDeltaAmount: number;
  dietaryMarker: DietaryMarker;
  isDefault: boolean;
  availability: RawAvailability | null;
}

interface RawGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  /** Set when the group applies to one variant only. */
  variantId: string | null;
  options: RawOption[];
}

export interface RawItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  basePriceAmount: number;
  discountedPriceAmount: number | null;
  dietaryMarker: DietaryMarker;
  spiceLevel: number | null;
  servingSize: string | null;
  prepMinutes: number | null;
  isBestseller: boolean;
  isRecommended: boolean;
  isTodaysSpecial: boolean;
  isCombo: boolean;
  /** Per-item packaging override (BR-PRICE-006). */
  packagingFeeAmount: number | null;
  tags: string[];
  allergens: string[];
  ingredients: string[];
  variants: { id: string; name: string; priceAmount: number; isDefault: boolean }[];
  groups: RawGroup[];
  availability: RawAvailability | null;
  /** null = stock not tracked. */
  stock: number | null;
}

export interface RawMenu {
  branchId: string;
  menuVersion: number;
  categories: { id: string; name: string; description: string | null }[];
  items: RawItem[];
}

/* ------------------------------------------------------------------------- */

export type UnavailableReason = 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'BRANCH_CLOSED';

export interface ItemCard {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  /** Effective price: default variant price, else discounted price, else base price. */
  priceAmount: number;
  /** Struck-through price when discounted (FR-MENUC-003). */
  originalPriceAmount: number | null;
  dietaryMarker: DietaryMarker;
  tags: string[];
  spiceLevel: number | null;
  isBestseller: boolean;
  isRecommended: boolean;
  isTodaysSpecial: boolean;
  customizable: boolean;
  available: boolean;
  unavailableReason: UnavailableReason | null;
  /** When it can be ordered again, if known. */
  availableAt: string | null;
}

const CACHE_TTL_SECONDS = 3600;

export class MenuService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache: Redis,
    private readonly logger: Logger,
  ) {}

  /** FR-MENUC-008: served from cache keyed by branch + menu version; database on miss or cache outage. */
  async raw(branch: BranchRecord): Promise<RawMenu> {
    const key = `menu:v2:${branch.id}:${branch.menuVersion}`;
    const hit = await softRedis(this.cache, (r) => r.get(key), null);
    if (hit) return JSON.parse(hit) as RawMenu;
    const menu = await this.load(branch);
    await softRedis(
      this.cache,
      (r) => r.set(key, JSON.stringify(menu), 'EX', CACHE_TTL_SECONDS),
      null,
    );
    return menu;
  }

  private async load(branch: BranchRecord): Promise<RawMenu> {
    const live = { deletedAt: null };
    const [categories, items, itemAvailability, optionAvailability, stock] = await Promise.all([
      this.prisma.menuCategory.findMany({
        where: { restaurantId: branch.restaurantId, ...live, isActive: true },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, description: true },
      }),
      this.prisma.foodItem.findMany({
        where: {
          restaurantId: branch.restaurantId,
          ...live,
          isHidden: false,
          category: { ...live, isActive: true },
        },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        include: {
          tags: { select: { tag: true } },
          allergens: { select: { allergen: true } },
          ingredients: { select: { name: true } },
          variants: { where: live, orderBy: { position: 'asc' } },
          customizationGroups: {
            where: { group: live },
            orderBy: { position: 'asc' },
            include: {
              group: { include: { options: { where: live, orderBy: { position: 'asc' } } } },
            },
          },
        },
      }),
      this.prisma.branchItemAvailability.findMany({ where: { branchId: branch.id } }),
      this.prisma.branchOptionAvailability.findMany({ where: { branchId: branch.id } }),
      this.prisma.branchItemStock.findMany({ where: { branchId: branch.id } }),
    ]);
    const avail = (row?: {
      isAvailable: boolean;
      unavailableUntil: Date | null;
    }): RawAvailability | null =>
      row
        ? {
            isAvailable: row.isAvailable,
            unavailableUntil: row.unavailableUntil?.toISOString() ?? null,
          }
        : null;
    const itemAvail = new Map(itemAvailability.map((a) => [a.foodItemId, a]));
    const optionAvail = new Map(optionAvailability.map((a) => [a.optionId, a]));
    const stockBy = new Map(stock.map((s) => [s.foodItemId, s.quantity]));

    return {
      branchId: branch.id,
      menuVersion: branch.menuVersion,
      categories,
      items: items.map((i) => ({
        id: i.id,
        categoryId: i.categoryId,
        name: i.name,
        description: i.description,
        basePriceAmount: i.basePriceAmount,
        discountedPriceAmount: i.discountedPriceAmount,
        dietaryMarker: i.dietaryMarker,
        spiceLevel: i.spiceLevel,
        servingSize: i.servingSize,
        prepMinutes: i.prepMinutes,
        isBestseller: i.isBestseller,
        isRecommended: i.isRecommended,
        isTodaysSpecial: i.isTodaysSpecial,
        isCombo: i.isCombo,
        packagingFeeAmount: i.packagingFeeAmount,
        tags: i.tags.map((t) => t.tag).sort(),
        allergens: i.allergens.map((a) => a.allergen).sort(),
        ingredients: i.ingredients.map((x) => x.name),
        variants: i.variants.map((v) => ({
          id: v.id,
          name: v.name,
          priceAmount: v.priceAmount,
          isDefault: v.isDefault,
        })),
        groups: i.customizationGroups.map((link) => ({
          id: link.group.id,
          name: link.group.name,
          minSelect: link.group.minSelect,
          maxSelect: link.group.maxSelect,
          variantId: link.variantId,
          options: link.group.options.map((o) => ({
            id: o.id,
            name: o.name,
            priceDeltaAmount: o.priceDeltaAmount,
            dietaryMarker: o.dietaryMarker,
            isDefault: o.isDefault,
            availability: avail(optionAvail.get(o.id)),
          })),
        })),
        availability: avail(itemAvail.get(i.id)),
        stock: stockBy.has(i.id) ? (stockBy.get(i.id) ?? 0) : null,
      })),
    };
  }
}

/* ------------------------------------------------------------------------- *
 * Resolution (pure)
 * ------------------------------------------------------------------------- */

/** Marked unavailable and not yet back (BR-MENU-007). */
export const blocked = (a: RawAvailability | null, now: Date) =>
  Boolean(a && !a.isAvailable && (!a.unavailableUntil || new Date(a.unavailableUntil) > now));

/** BR-MENU-007 at read time. Item schedules (CORE) are not applied yet. */
export function itemAvailability(
  item: RawItem,
  branch: { acceptingOrders: boolean; opensAt: Date | null },
  now: Date,
): { available: boolean; unavailableReason: UnavailableReason | null; availableAt: string | null } {
  if (blocked(item.availability, now)) {
    return {
      available: false,
      unavailableReason: 'UNAVAILABLE',
      availableAt: item.availability?.unavailableUntil ?? null,
    };
  }
  if (item.stock !== null && item.stock <= 0)
    return { available: false, unavailableReason: 'OUT_OF_STOCK', availableAt: null };
  if (!branch.acceptingOrders) {
    return {
      available: false,
      unavailableReason: 'BRANCH_CLOSED',
      availableAt: branch.opensAt?.toISOString() ?? null,
    };
  }
  return { available: true, unavailableReason: null, availableAt: null };
}

function price(item: RawItem): { priceAmount: number; originalPriceAmount: number | null } {
  if (item.variants.length > 0) {
    // BR-MENU-004: the default variant's price replaces the base price.
    const v = item.variants.find((x) => x.isDefault) ?? item.variants[0]!;
    return { priceAmount: v.priceAmount, originalPriceAmount: null };
  }
  if (item.discountedPriceAmount !== null && item.discountedPriceAmount < item.basePriceAmount) {
    return { priceAmount: item.discountedPriceAmount, originalPriceAmount: item.basePriceAmount };
  }
  return { priceAmount: item.basePriceAmount, originalPriceAmount: null };
}

export function toCard(
  item: RawItem,
  branch: { acceptingOrders: boolean; opensAt: Date | null },
  now: Date,
): ItemCard {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    imageUrl: null, // item images are served once file storage lands (Phase 8)
    ...price(item),
    dietaryMarker: item.dietaryMarker,
    tags: item.tags,
    spiceLevel: item.spiceLevel,
    isBestseller: item.isBestseller,
    isRecommended: item.isRecommended,
    isTodaysSpecial: item.isTodaysSpecial,
    customizable: item.groups.length > 0 || item.variants.length > 1,
    ...itemAvailability(item, branch, now),
  };
}

export const isVeg = (item: { dietaryMarker: DietaryMarker }) => item.dietaryMarker === 'VEG';

/** FR-MENUC-002: categories in order, preceded by smart sections (item IDs referencing the categories). */
export function resolveMenu(
  raw: RawMenu,
  branch: { acceptingOrders: boolean; opensAt: Date | null },
  now: Date,
  options: { vegOnly: boolean },
) {
  const items = raw.items.filter((i) => !options.vegOnly || isVeg(i));
  const cards = items.map((i) => toCard(i, branch, now));
  const byCategory = new Map<string, ItemCard[]>();
  for (const card of cards)
    byCategory.set(card.categoryId, [...(byCategory.get(card.categoryId) ?? []), card]);
  const section = (key: string, title: string, pick: (c: ItemCard) => boolean) => ({
    key,
    title,
    itemIds: cards.filter(pick).map((c) => c.id),
  });
  return {
    branchId: raw.branchId,
    menuVersion: raw.menuVersion,
    vegOnly: options.vegOnly,
    sections: [
      section('recommended', 'Recommended', (c) => c.isRecommended),
      // FR-MENUC-002 also ranks the top 10 by 30-day orders; that joins in once orders exist (Phase 7).
      section('bestsellers', 'Bestsellers', (c) => c.isBestseller),
      section('todays-special', "Today's Special", (c) => c.isTodaysSpecial),
    ].filter((s) => s.itemIds.length > 0),
    categories: raw.categories
      .map((c) => ({ ...c, items: byCategory.get(c.id) ?? [] }))
      .filter((c) => c.items.length > 0),
  };
}

/** FR-MENUC-004: full item details, with customisation availability. */
export function itemDetails(
  item: RawItem,
  branch: { acceptingOrders: boolean; opensAt: Date | null },
  now: Date,
  customerAllergens: string[] = [],
) {
  const card = toCard(item, branch, now);
  return {
    ...card,
    images: [] as string[],
    servingSize: item.servingSize,
    prepMinutes: item.prepMinutes,
    ingredients: item.ingredients,
    allergens: item.allergens,
    // FR-MENUC-007: informational only (A-08).
    allergenWarnings: item.allergens.filter((a) => customerAllergens.includes(a)),
    variants: item.variants,
    customizationGroups: item.groups.map((g) => ({
      id: g.id,
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      required: g.minSelect >= 1,
      variantId: g.variantId,
      options: g.options.map((o) => ({
        id: o.id,
        name: o.name,
        priceDeltaAmount: o.priceDeltaAmount,
        dietaryMarker: o.dietaryMarker,
        isDefault: o.isDefault,
        available: !blocked(o.availability, now),
      })),
    })),
  };
}

export type ResolvedMenu = ReturnType<typeof resolveMenu>;
