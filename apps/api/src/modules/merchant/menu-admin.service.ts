import type { DietaryMarker, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { AuditService } from '../audit';
import { localParts, zonedInstant } from '../catalog';
import type { FilesService } from '../files';

type Tx = Prisma.TransactionClient;

export const MIN_PRICE = 100; // BR-MENU-002
export const MAX_PRICE = 10_000_000;
const MAX_IMAGES = 5; // FR-MENU-003

export interface ItemInput {
  categoryId: string;
  name: string;
  description?: string | null | undefined;
  basePriceAmount: number;
  discountedPriceAmount?: number | null | undefined;
  dietaryMarker: DietaryMarker;
  spiceLevel?: number | null | undefined;
  servingSize?: string | null | undefined;
  prepMinutes?: number | null | undefined;
  calories?: number | null | undefined;
  isBestseller?: boolean | undefined;
  isRecommended?: boolean | undefined;
  isTodaysSpecial?: boolean | undefined;
  isFeatured?: boolean | undefined;
  isHidden?: boolean | undefined;
  packagingFeeAmount?: number | null | undefined;
  tags?: string[] | undefined;
  allergens?: string[] | undefined;
  ingredients?: string[] | undefined;
  variants?: { name: string; priceAmount: number; isDefault?: boolean | undefined }[] | undefined;
}

const bad = (path: string, message: string, code = 'INVALID') =>
  new AppError('VALIDATION_ERROR', { details: [{ path, code, message }] });

/**
 * Restaurant menu management (FR-MENU-001…008, 012; API-RMENU-001…026). The
 * menu belongs to the restaurant, so structural changes bump `menu_version`
 * on every branch; availability changes bump only the branch they affect.
 */
export class MenuAdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async bump(tx: Tx, restaurantId: string) {
    await tx.branch.updateMany({
      where: { restaurantId },
      data: { menuVersion: { increment: 1 } },
    });
  }

  private async log(
    tx: Tx,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    after?: Record<string, unknown>,
  ) {
    await this.audit.record(
      { action, targetType, targetId, actorUserId: actorId, after: after ?? null },
      tx,
    );
  }

  /* ----------------------------- reads ----------------------------- */

  /** API-RMENU-001: everything, including hidden items and disabled categories. */
  async menu(restaurantId: string, branchId?: string) {
    const now = this.clock.now();
    const [categories, groups, itemAvail, optionAvail] = await Promise.all([
      this.prisma.menuCategory.findMany({
        where: { restaurantId, deletedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        include: {
          items: {
            where: { deletedAt: null },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            include: this.itemInclude(),
          },
        },
      }),
      this.groups(restaurantId),
      branchId
        ? this.prisma.branchItemAvailability.findMany({ where: { branchId } })
        : Promise.resolve([]),
      branchId
        ? this.prisma.branchOptionAvailability.findMany({ where: { branchId } })
        : Promise.resolve([]),
    ]);
    const unavailable = (rows: { isAvailable: boolean; unavailableUntil: Date | null }[]) =>
      rows.some((r) => !r.isAvailable && (!r.unavailableUntil || r.unavailableUntil > now));
    return {
      restaurantId,
      branchId: branchId ?? null,
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        position: c.position,
        isActive: c.isActive,
        items: c.items.map((i) => ({
          ...this.itemView(i),
          ...(branchId
            ? {
                available: !unavailable(itemAvail.filter((a) => a.foodItemId === i.id)),
                unavailableUntil:
                  itemAvail.find((a) => a.foodItemId === i.id && !a.isAvailable)
                    ?.unavailableUntil ?? null,
              }
            : {}),
        })),
      })),
      customizationGroups: groups.map((g) => ({
        ...g,
        options: g.options.map((o) => ({
          ...o,
          ...(branchId
            ? { available: !unavailable(optionAvail.filter((a) => a.optionId === o.id)) }
            : {}),
        })),
      })),
    };
  }

  private itemInclude() {
    return {
      tags: true,
      allergens: true,
      ingredients: { orderBy: { position: 'asc' } },
      images: { orderBy: { position: 'asc' }, include: { file: true } },
      variants: {
        where: { deletedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      },
      customizationGroups: { orderBy: { position: 'asc' } },
    } satisfies Prisma.FoodItemInclude;
  }

  private itemView(
    i: Prisma.FoodItemGetPayload<{ include: ReturnType<MenuAdminService['itemInclude']> }>,
  ) {
    return {
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
      calories: i.calories,
      isBestseller: i.isBestseller,
      isRecommended: i.isRecommended,
      isTodaysSpecial: i.isTodaysSpecial,
      isFeatured: i.isFeatured,
      isHidden: i.isHidden,
      hiddenReason: i.hiddenReason,
      packagingFeeAmount: i.packagingFeeAmount,
      position: i.position,
      tags: i.tags.map((t) => t.tag),
      allergens: i.allergens.map((a) => a.allergen),
      ingredients: i.ingredients.map((x) => x.name),
      images: i.images.map((im) => ({
        id: im.id,
        fileId: im.fileId,
        position: im.position,
        urls: this.files.urls(im.file),
      })),
      variants: i.variants.map((v) => ({
        id: v.id,
        name: v.name,
        priceAmount: v.priceAmount,
        isDefault: v.isDefault,
        position: v.position,
      })),
      customizationGroups: i.customizationGroups.map((g) => ({
        groupId: g.groupId,
        variantId: g.variantId,
        position: g.position,
      })),
      version: i.version,
    };
  }

  /** API-RMENU-008 */
  async item(restaurantId: string, itemId: string) {
    const i = await this.prisma.foodItem.findFirst({
      where: { id: itemId, restaurantId, deletedAt: null },
      include: this.itemInclude(),
    });
    if (!i) throw new AppError('ITEM_NOT_FOUND');
    return this.itemView(i);
  }

  /* ----------------------------- categories ----------------------------- */

  async createCategory(
    actorId: string,
    restaurantId: string,
    input: {
      name: string;
      description?: string | null | undefined;
      isActive?: boolean | undefined;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.menuCategory.aggregate({
        where: { restaurantId, deletedAt: null },
        _max: { position: true },
      });
      const c = await tx.menuCategory.create({
        data: {
          restaurantId,
          name: input.name,
          description: input.description ?? null,
          isActive: input.isActive ?? true,
          position: (last._max.position ?? -1) + 1,
        },
      });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.category_created', 'menu_category', c.id);
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        isActive: c.isActive,
        position: c.position,
      };
    });
  }

  private async category(tx: Tx | PrismaClient, restaurantId: string, id: string) {
    const c = await tx.menuCategory.findFirst({ where: { id, restaurantId, deletedAt: null } });
    if (!c) throw new AppError('NOT_FOUND', { message: "We couldn't find that category." });
    return c;
  }

  async updateCategory(
    actorId: string,
    restaurantId: string,
    id: string,
    patch: {
      name?: string | undefined;
      description?: string | null | undefined;
      isActive?: boolean | undefined;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.category(tx, restaurantId, id);
      const c = await tx.menuCategory.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        },
      });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.category_updated', 'menu_category', id, { ...patch });
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        isActive: c.isActive,
        position: c.position,
      };
    });
  }

  /** BR-MENU-008: only empty, or with a target for its items. */
  async deleteCategory(actorId: string, restaurantId: string, id: string, moveItemsTo?: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.category(tx, restaurantId, id);
      const count = await tx.foodItem.count({ where: { categoryId: id, deletedAt: null } });
      if (count > 0) {
        if (!moveItemsTo || moveItemsTo === id)
          throw new AppError('VALIDATION_ERROR', {
            message: 'Move this category’s dishes to another category first.',
            details: [
              {
                path: 'moveItemsTo',
                code: 'REQUIRED',
                message: `${count} dish(es) in this category`,
              },
            ],
          });
        await this.category(tx, restaurantId, moveItemsTo);
        const last = await tx.foodItem.aggregate({
          where: { categoryId: moveItemsTo, deletedAt: null },
          _max: { position: true },
        });
        const items = await tx.foodItem.findMany({
          where: { categoryId: id, deletedAt: null },
          orderBy: { position: 'asc' },
          select: { id: true },
        });
        let pos = (last._max.position ?? -1) + 1;
        for (const it of items)
          await tx.foodItem.update({
            where: { id: it.id },
            data: { categoryId: moveItemsTo, position: pos++, version: { increment: 1 } },
          });
      }
      await tx.menuCategory.update({
        where: { id },
        data: { deletedAt: this.clock.now(), isActive: false },
      });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.category_deleted', 'menu_category', id, {
        moveItemsTo: moveItemsTo ?? null,
      });
    });
  }

  /** API-RMENU-005/006: positions follow the given order; the list must be complete. */
  async reorderCategories(actorId: string, restaurantId: string, ids: string[]) {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.menuCategory.findMany({
        where: { restaurantId, deletedAt: null },
        select: { id: true },
      });
      this.sameSet(
        existing.map((c) => c.id),
        ids,
        'categoryIds',
      );
      for (const [position, id] of ids.entries())
        await tx.menuCategory.update({ where: { id }, data: { position } });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.categories_reordered', 'restaurant', restaurantId);
    });
  }

  async reorderItems(actorId: string, restaurantId: string, categoryId: string, ids: string[]) {
    await this.prisma.$transaction(async (tx) => {
      await this.category(tx, restaurantId, categoryId);
      const existing = await tx.foodItem.findMany({
        where: { categoryId, deletedAt: null },
        select: { id: true },
      });
      this.sameSet(
        existing.map((c) => c.id),
        ids,
        'itemIds',
      );
      for (const [position, id] of ids.entries())
        await tx.foodItem.update({ where: { id }, data: { position } });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.items_reordered', 'menu_category', categoryId);
    });
  }

  private sameSet(existing: string[], given: string[], path: string) {
    const a = new Set(existing);
    if (
      given.length !== a.size ||
      new Set(given).size !== given.length ||
      given.some((x) => !a.has(x))
    )
      throw bad(path, 'Send every entry exactly once, in the new order.');
  }

  /* ----------------------------- items ----------------------------- */

  private async checkItem(
    tx: Tx,
    restaurantId: string,
    input: Partial<ItemInput>,
    current?: { basePriceAmount: number; dietaryMarker: DietaryMarker; id: string },
  ) {
    const base = input.basePriceAmount ?? current?.basePriceAmount;
    if (
      input.basePriceAmount !== undefined &&
      (input.basePriceAmount < MIN_PRICE || input.basePriceAmount > MAX_PRICE)
    )
      throw bad('basePriceAmount', 'Price must be between ₹1 and ₹1,00,000.', 'OUT_OF_RANGE');
    if (
      input.discountedPriceAmount != null &&
      (input.discountedPriceAmount < MIN_PRICE ||
        base === undefined ||
        input.discountedPriceAmount >= base)
    )
      throw bad(
        'discountedPriceAmount',
        'The offer price must be at least ₹1 and lower than the price.',
        'OUT_OF_RANGE',
      ); // BR-MENU-005
    if (input.categoryId) await this.category(tx, restaurantId, input.categoryId);
    const marker = input.dietaryMarker ?? current?.dietaryMarker;
    if (input.dietaryMarker && input.dietaryMarker !== 'VEG') {
      const r = await tx.restaurant.findUniqueOrThrow({
        where: { id: restaurantId },
        select: { pureVeg: true },
      });
      if (r.pureVeg) throw bad('dietaryMarker', 'This is a pure-veg restaurant: only VEG dishes.'); // BR-MENU-001
    }
    if (current && marker === 'VEG' && input.dietaryMarker === 'VEG')
      await this.vegOnlyOptions(tx, current.id);
  }

  /** BR-MENU-001: a VEG item can't offer NON_VEG/EGG options. */
  private async vegOnlyOptions(tx: Tx, itemId: string, extraGroupIds: string[] = []) {
    const groups = await tx.foodItemCustomizationGroup.findMany({
      where: { foodItemId: itemId },
      select: { groupId: true },
    });
    const ids = [...groups.map((g) => g.groupId), ...extraGroupIds];
    if (!ids.length) return;
    const nonVeg = await tx.customizationOption.count({
      where: { groupId: { in: ids }, deletedAt: null, dietaryMarker: { not: 'VEG' } },
    });
    if (nonVeg) throw bad('dietaryMarker', 'A VEG dish can’t have non-veg or egg add-ons.');
  }

  private async setLists(tx: Tx, itemId: string, input: Partial<ItemInput>) {
    if (input.tags) {
      await tx.foodItemTag.deleteMany({ where: { foodItemId: itemId } });
      await tx.foodItemTag.createMany({
        data: [...new Set(input.tags)].map((tag) => ({ foodItemId: itemId, tag: tag as never })),
      });
    }
    if (input.allergens) {
      await tx.foodItemAllergen.deleteMany({ where: { foodItemId: itemId } });
      await tx.foodItemAllergen.createMany({
        data: [...new Set(input.allergens)].map((allergen) => ({
          foodItemId: itemId,
          allergen: allergen as never,
        })),
      });
    }
    if (input.ingredients) {
      await tx.foodItemIngredient.deleteMany({ where: { foodItemId: itemId } });
      await tx.foodItemIngredient.createMany({
        data: input.ingredients.map((name, position) => ({ foodItemId: itemId, name, position })),
      });
    }
  }

  private scalar(input: Partial<ItemInput>) {
    const keys = [
      'categoryId',
      'name',
      'description',
      'basePriceAmount',
      'discountedPriceAmount',
      'dietaryMarker',
      'spiceLevel',
      'servingSize',
      'prepMinutes',
      'calories',
      'isBestseller',
      'isRecommended',
      'isTodaysSpecial',
      'isFeatured',
      'isHidden',
      'packagingFeeAmount',
    ] as const;
    return Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  }

  /** API-RMENU-007 (FR-MENU-003) */
  async createItem(actorId: string, restaurantId: string, input: ItemInput) {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.checkItem(tx, restaurantId, input);
      if (input.variants?.length) this.checkVariants(input.variants);
      const last = await tx.foodItem.aggregate({
        where: { categoryId: input.categoryId, deletedAt: null },
        _max: { position: true },
      });
      const item = await tx.foodItem.create({
        data: {
          ...(this.scalar(input) as unknown as Prisma.FoodItemUncheckedCreateInput),
          restaurantId,
          categoryId: input.categoryId,
          name: input.name,
          basePriceAmount: input.basePriceAmount,
          dietaryMarker: input.dietaryMarker,
          position: (last._max.position ?? -1) + 1,
        },
      });
      await this.setLists(tx, item.id, input);
      if (input.variants?.length) {
        const hasDefault = input.variants.some((v) => v.isDefault);
        await tx.foodItemVariant.createMany({
          data: input.variants.map((v, position) => ({
            foodItemId: item.id,
            name: v.name,
            priceAmount: v.priceAmount,
            isDefault: hasDefault ? Boolean(v.isDefault) : position === 0,
            position,
          })),
        });
      }
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.item_created', 'food_item', item.id, {
        name: item.name,
        price: item.basePriceAmount,
      });
      return item.id;
    });
    return this.item(restaurantId, id);
  }

  private checkVariants(variants: { priceAmount: number; isDefault?: boolean | undefined }[]) {
    if (variants.filter((v) => v.isDefault).length > 1)
      throw bad('variants', 'Only one variant can be the default.'); // BR-MENU-004
    for (const v of variants)
      if (v.priceAmount < MIN_PRICE || v.priceAmount > MAX_PRICE)
        throw bad('variants', 'Variant prices must be between ₹1 and ₹1,00,000.', 'OUT_OF_RANGE');
  }

  private async lockItem(tx: Tx, restaurantId: string, itemId: string) {
    await tx.$queryRaw`SELECT id FROM food_items WHERE id = ${itemId}::uuid FOR UPDATE`;
    const i = await tx.foodItem.findFirst({ where: { id: itemId, restaurantId, deletedAt: null } });
    if (!i) throw new AppError('ITEM_NOT_FOUND');
    return i;
  }

  /** API-RMENU-009 (FR-MENU-004, 012). `expectedVersion` comes from If-Match. */
  async updateItem(
    actorId: string,
    restaurantId: string,
    itemId: string,
    patch: Partial<ItemInput>,
    expectedVersion?: number,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockItem(tx, restaurantId, itemId);
      if (expectedVersion !== undefined && expectedVersion !== current.version)
        throw new AppError('CONFLICT_STALE_VERSION', {
          message: 'Someone else changed this dish. Reload and try again.',
        });
      await this.checkItem(tx, restaurantId, patch, current);
      // A new base price must stay above an existing offer price.
      if (
        patch.basePriceAmount !== undefined &&
        patch.discountedPriceAmount === undefined &&
        current.discountedPriceAmount != null &&
        current.discountedPriceAmount >= patch.basePriceAmount
      )
        throw bad(
          'discountedPriceAmount',
          'The offer price must be lower than the new price.',
          'OUT_OF_RANGE',
        );
      await tx.foodItem.update({
        where: { id: itemId },
        data: {
          ...(this.scalar(patch) as unknown as Prisma.FoodItemUncheckedUpdateInput),
          version: { increment: 1 },
        },
      });
      await this.setLists(tx, itemId, patch);
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.item_updated', 'food_item', itemId, {
        fields: Object.keys(patch),
        ...(patch.basePriceAmount !== undefined
          ? { priceFrom: current.basePriceAmount, priceTo: patch.basePriceAmount }
          : {}),
      });
    });
    return this.item(restaurantId, itemId);
  }

  /** API-RMENU-010 (FR-MENU-005): soft delete; carts flag the line. */
  async deleteItem(actorId: string, restaurantId: string, itemId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockItem(tx, restaurantId, itemId);
      await tx.foodItem.update({
        where: { id: itemId },
        data: { deletedAt: this.clock.now(), version: { increment: 1 } },
      });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.item_deleted', 'food_item', itemId);
    });
  }

  /* ----------------------------- images ----------------------------- */

  async addImage(actorId: string, restaurantId: string, itemId: string, fileId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockItem(tx, restaurantId, itemId);
      const images = await tx.foodItemImage.findMany({
        where: { foodItemId: itemId },
        orderBy: { position: 'asc' },
      });
      if (images.length >= MAX_IMAGES)
        throw bad('fileId', `At most ${MAX_IMAGES} photos per dish.`, 'LIMIT');
      await this.files.claim(tx, { fileId, userId: actorId, purposes: ['FOOD_IMAGE'] });
      await tx.foodItemImage.create({
        data: { foodItemId: itemId, fileId, position: (images.at(-1)?.position ?? -1) + 1 },
      });
      await tx.foodItem.update({ where: { id: itemId }, data: { version: { increment: 1 } } });
      await this.bump(tx, restaurantId);
    });
    return this.item(restaurantId, itemId);
  }

  async removeImage(actorId: string, restaurantId: string, itemId: string, imageId: string) {
    const fileId = await this.prisma.$transaction(async (tx) => {
      await this.lockItem(tx, restaurantId, itemId);
      const img = await tx.foodItemImage.findFirst({ where: { id: imageId, foodItemId: itemId } });
      if (!img) throw new AppError('NOT_FOUND', { message: "We couldn't find that photo." });
      await tx.foodItemImage.delete({ where: { id: imageId } });
      await this.compactImages(tx, itemId);
      await tx.foodItem.update({ where: { id: itemId }, data: { version: { increment: 1 } } });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.image_removed', 'food_item', itemId);
      return img.fileId;
    });
    await this.files.release(fileId);
    return this.item(restaurantId, itemId);
  }

  /** Positions are unique per item, so move everything out of the way first. */
  private async writeImageOrder(tx: Tx, itemId: string, ids: string[]) {
    for (const [i, id] of ids.entries())
      await tx.foodItemImage.update({ where: { id }, data: { position: 1000 + i } });
    for (const [i, id] of ids.entries())
      await tx.foodItemImage.update({ where: { id }, data: { position: i } });
  }

  private async compactImages(tx: Tx, itemId: string) {
    const rest = await tx.foodItemImage.findMany({
      where: { foodItemId: itemId },
      orderBy: { position: 'asc' },
    });
    await this.writeImageOrder(
      tx,
      itemId,
      rest.map((r) => r.id),
    );
  }

  async reorderImages(actorId: string, restaurantId: string, itemId: string, ids: string[]) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockItem(tx, restaurantId, itemId);
      const existing = await tx.foodItemImage.findMany({
        where: { foodItemId: itemId },
        select: { id: true },
      });
      this.sameSet(
        existing.map((x) => x.id),
        ids,
        'imageIds',
      );
      await this.writeImageOrder(tx, itemId, ids);
      await tx.foodItem.update({ where: { id: itemId }, data: { version: { increment: 1 } } });
      await this.bump(tx, restaurantId);
    });
    return this.item(restaurantId, itemId);
  }

  /* ----------------------------- variants ----------------------------- */

  async addVariant(
    actorId: string,
    restaurantId: string,
    itemId: string,
    input: { name: string; priceAmount: number; isDefault?: boolean | undefined },
  ) {
    this.checkVariants([input]);
    await this.prisma.$transaction(async (tx) => {
      await this.lockItem(tx, restaurantId, itemId);
      const existing = await tx.foodItemVariant.findMany({
        where: { foodItemId: itemId, deletedAt: null },
      });
      const makeDefault = input.isDefault || existing.length === 0;
      if (makeDefault)
        await tx.foodItemVariant.updateMany({
          where: { foodItemId: itemId },
          data: { isDefault: false },
        });
      await tx.foodItemVariant.create({
        data: {
          foodItemId: itemId,
          name: input.name,
          priceAmount: input.priceAmount,
          isDefault: makeDefault,
          position: existing.length,
        },
      });
      await tx.foodItem.update({ where: { id: itemId }, data: { version: { increment: 1 } } });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.variant_added', 'food_item', itemId, { name: input.name });
    });
    return this.item(restaurantId, itemId);
  }

  async updateVariant(
    actorId: string,
    restaurantId: string,
    itemId: string,
    variantId: string,
    patch: {
      name?: string | undefined;
      priceAmount?: number | undefined;
      isDefault?: boolean | undefined;
    },
  ) {
    if (patch.priceAmount !== undefined) this.checkVariants([{ priceAmount: patch.priceAmount }]);
    await this.prisma.$transaction(async (tx) => {
      await this.lockItem(tx, restaurantId, itemId);
      const v = await tx.foodItemVariant.findFirst({
        where: { id: variantId, foodItemId: itemId, deletedAt: null },
      });
      if (!v) throw new AppError('NOT_FOUND', { message: "We couldn't find that variant." });
      if (patch.isDefault === false && v.isDefault)
        throw bad('isDefault', 'Choose another variant as the default instead.'); // BR-MENU-004
      if (patch.isDefault)
        await tx.foodItemVariant.updateMany({
          where: { foodItemId: itemId },
          data: { isDefault: false },
        });
      await tx.foodItemVariant.update({
        where: { id: variantId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.priceAmount !== undefined ? { priceAmount: patch.priceAmount } : {}),
          ...(patch.isDefault ? { isDefault: true } : {}),
        },
      });
      await tx.foodItem.update({ where: { id: itemId }, data: { version: { increment: 1 } } });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.variant_updated', 'food_item', itemId, {
        variantId,
        ...patch,
      });
    });
    return this.item(restaurantId, itemId);
  }

  async deleteVariant(actorId: string, restaurantId: string, itemId: string, variantId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockItem(tx, restaurantId, itemId);
      const v = await tx.foodItemVariant.findFirst({
        where: { id: variantId, foodItemId: itemId, deletedAt: null },
      });
      if (!v) throw new AppError('NOT_FOUND', { message: "We couldn't find that variant." });
      await tx.foodItemVariant.update({
        where: { id: variantId },
        data: { deletedAt: this.clock.now(), isDefault: false },
      });
      await tx.foodItemCustomizationGroup.deleteMany({ where: { variantId } });
      if (v.isDefault) {
        // BR-MENU-004: another variant becomes the default.
        const next = await tx.foodItemVariant.findFirst({
          where: { foodItemId: itemId, deletedAt: null },
          orderBy: { position: 'asc' },
        });
        if (next)
          await tx.foodItemVariant.update({ where: { id: next.id }, data: { isDefault: true } });
      }
      await tx.foodItem.update({ where: { id: itemId }, data: { version: { increment: 1 } } });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.variant_deleted', 'food_item', itemId, { variantId });
    });
    return this.item(restaurantId, itemId);
  }

  /* ----------------------------- customization ----------------------------- */

  /** API-RMENU-017 */
  async groups(restaurantId: string) {
    const rows = await this.prisma.customizationGroup.findMany({
      where: { restaurantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: {
        options: {
          where: { deletedAt: null },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
        _count: { select: { attachments: true } },
      },
    });
    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      required: g.minSelect >= 1,
      attachedTo: g._count.attachments,
      options: g.options.map((o) => ({
        id: o.id,
        name: o.name,
        priceDeltaAmount: o.priceDeltaAmount,
        dietaryMarker: o.dietaryMarker,
        isDefault: o.isDefault,
        position: o.position,
      })),
    }));
  }

  private async group(tx: Tx | PrismaClient, restaurantId: string, id: string) {
    const g = await tx.customizationGroup.findFirst({
      where: { id, restaurantId, deletedAt: null },
      include: { options: { where: { deletedAt: null } } },
    });
    if (!g) throw new AppError('NOT_FOUND', { message: "We couldn't find that option group." });
    return g;
  }

  /** BR-MENU-003: 0 ≤ min ≤ max, max ≥ 1, max ≤ number of options (once options exist). */
  private checkGroupRules(min: number, max: number, optionCount: number | null) {
    if (min < 0 || max < 1 || min > max)
      throw bad('maxSelect', 'Choose limits with 0 ≤ minimum ≤ maximum and maximum ≥ 1.');
    if (optionCount !== null && max > optionCount)
      throw bad('maxSelect', `The maximum can’t exceed the number of options (${optionCount}).`);
  }

  async createGroup(
    actorId: string,
    restaurantId: string,
    input: {
      name: string;
      minSelect: number;
      maxSelect: number;
      options?:
        | {
            name: string;
            priceDeltaAmount: number;
            dietaryMarker: DietaryMarker;
            isDefault?: boolean | undefined;
          }[]
        | undefined;
    },
  ) {
    this.checkGroupRules(
      input.minSelect,
      input.maxSelect,
      input.options?.length ? input.options.length : null,
    );
    const g = await this.prisma.$transaction(async (tx) => {
      const g = await tx.customizationGroup.create({
        data: {
          restaurantId,
          name: input.name,
          minSelect: input.minSelect,
          maxSelect: input.maxSelect,
        },
      });
      if (input.options?.length)
        await tx.customizationOption.createMany({
          data: input.options.map((o, position) => ({
            groupId: g.id,
            name: o.name,
            priceDeltaAmount: o.priceDeltaAmount,
            dietaryMarker: o.dietaryMarker,
            isDefault: Boolean(o.isDefault),
            position,
          })),
        });
      await this.log(tx, actorId, 'menu.group_created', 'customization_group', g.id);
      return g;
    });
    return (await this.groups(restaurantId)).find((x) => x.id === g.id)!;
  }

  async updateGroup(
    actorId: string,
    restaurantId: string,
    id: string,
    patch: {
      name?: string | undefined;
      minSelect?: number | undefined;
      maxSelect?: number | undefined;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const g = await this.group(tx, restaurantId, id);
      this.checkGroupRules(
        patch.minSelect ?? g.minSelect,
        patch.maxSelect ?? g.maxSelect,
        g.options.length || null,
      );
      await tx.customizationGroup.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.minSelect !== undefined ? { minSelect: patch.minSelect } : {}),
          ...(patch.maxSelect !== undefined ? { maxSelect: patch.maxSelect } : {}),
        },
      });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.group_updated', 'customization_group', id, { ...patch });
    });
    return (await this.groups(restaurantId)).find((x) => x.id === id)!;
  }

  async deleteGroup(actorId: string, restaurantId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.group(tx, restaurantId, id);
      const attached = await tx.foodItemCustomizationGroup.count({
        where: { groupId: id, foodItem: { deletedAt: null } },
      });
      if (attached)
        throw bad('groupId', `Remove this group from ${attached} dish(es) first.`, 'IN_USE');
      await tx.foodItemCustomizationGroup.deleteMany({ where: { groupId: id } });
      await tx.customizationGroup.update({ where: { id }, data: { deletedAt: this.clock.now() } });
      await this.log(tx, actorId, 'menu.group_deleted', 'customization_group', id);
    });
  }

  /** Options on VEG dishes must stay VEG (BR-MENU-001). */
  private async optionMarkerAllowed(tx: Tx, groupId: string, marker: DietaryMarker) {
    if (marker === 'VEG') return;
    const vegItems = await tx.foodItemCustomizationGroup.count({
      where: { groupId, foodItem: { dietaryMarker: 'VEG', deletedAt: null } },
    });
    if (vegItems)
      throw bad('dietaryMarker', 'This group is on VEG dishes, so its options must be VEG.');
  }

  async addOption(
    actorId: string,
    restaurantId: string,
    groupId: string,
    input: {
      name: string;
      priceDeltaAmount: number;
      dietaryMarker: DietaryMarker;
      isDefault?: boolean | undefined;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const g = await this.group(tx, restaurantId, groupId);
      await this.optionMarkerAllowed(tx, groupId, input.dietaryMarker);
      await tx.customizationOption.create({
        data: {
          groupId,
          name: input.name,
          priceDeltaAmount: input.priceDeltaAmount,
          dietaryMarker: input.dietaryMarker,
          isDefault: Boolean(input.isDefault),
          position: g.options.length,
        },
      });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.option_added', 'customization_group', groupId, {
        name: input.name,
      });
    });
    return (await this.groups(restaurantId)).find((x) => x.id === groupId)!;
  }

  async updateOption(
    actorId: string,
    restaurantId: string,
    groupId: string,
    optionId: string,
    patch: {
      name?: string | undefined;
      priceDeltaAmount?: number | undefined;
      dietaryMarker?: DietaryMarker | undefined;
      isDefault?: boolean | undefined;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const g = await this.group(tx, restaurantId, groupId);
      if (!g.options.some((o) => o.id === optionId))
        throw new AppError('NOT_FOUND', { message: "We couldn't find that option." });
      if (patch.dietaryMarker) await this.optionMarkerAllowed(tx, groupId, patch.dietaryMarker);
      await tx.customizationOption.update({
        where: { id: optionId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.priceDeltaAmount !== undefined
            ? { priceDeltaAmount: patch.priceDeltaAmount }
            : {}),
          ...(patch.dietaryMarker !== undefined ? { dietaryMarker: patch.dietaryMarker } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
        },
      });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.option_updated', 'customization_option', optionId, {
        ...patch,
      });
    });
    return (await this.groups(restaurantId)).find((x) => x.id === groupId)!;
  }

  async deleteOption(actorId: string, restaurantId: string, groupId: string, optionId: string) {
    await this.prisma.$transaction(async (tx) => {
      const g = await this.group(tx, restaurantId, groupId);
      if (!g.options.some((o) => o.id === optionId))
        throw new AppError('NOT_FOUND', { message: "We couldn't find that option." });
      if (g.options.length - 1 < g.maxSelect)
        throw bad(
          'optionId',
          `Lower the group’s maximum below ${g.maxSelect} before removing this option.`,
        ); // BR-MENU-003
      await tx.customizationOption.update({
        where: { id: optionId },
        data: { deletedAt: this.clock.now() },
      });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.option_deleted', 'customization_option', optionId);
    });
    return (await this.groups(restaurantId)).find((x) => x.id === groupId)!;
  }

  /** API-RMENU-024: replace the item's groups, in order, optionally per variant. */
  async attachGroups(
    actorId: string,
    restaurantId: string,
    itemId: string,
    links: { groupId: string; variantId?: string | null | undefined }[],
  ) {
    await this.prisma.$transaction(async (tx) => {
      const item = await this.lockItem(tx, restaurantId, itemId);
      const keys = links.map((l) => `${l.groupId}:${l.variantId ?? ''}`);
      if (new Set(keys).size !== keys.length)
        throw bad('groups', 'A group is listed twice for the same variant.');
      for (const l of links) {
        const g = await this.group(tx, restaurantId, l.groupId);
        if (g.options.length === 0) throw bad('groups', `“${g.name}” has no options yet.`);
        if (l.variantId) {
          const v = await tx.foodItemVariant.count({
            where: { id: l.variantId, foodItemId: itemId, deletedAt: null },
          });
          if (!v) throw bad('groups', 'That variant isn’t on this dish.');
        }
      }
      if (item.dietaryMarker === 'VEG')
        await this.vegOnlyOptions(
          tx,
          itemId,
          links.map((l) => l.groupId),
        );
      await tx.foodItemCustomizationGroup.deleteMany({ where: { foodItemId: itemId } });
      await tx.foodItemCustomizationGroup.createMany({
        data: links.map((l, position) => ({
          foodItemId: itemId,
          groupId: l.groupId,
          variantId: l.variantId ?? null,
          position,
        })),
      });
      await tx.foodItem.update({ where: { id: itemId }, data: { version: { increment: 1 } } });
      await this.bump(tx, restaurantId);
      await this.log(tx, actorId, 'menu.groups_attached', 'food_item', itemId, {
        groups: links.length,
      });
    });
    return this.item(restaurantId, itemId);
  }

  /* ----------------------------- availability ----------------------------- */

  /** End of the branch's local day, for "out of stock until end of day". */
  private async endOfDay(branchId: string) {
    const b = await this.prisma.branch.findUniqueOrThrow({
      where: { id: branchId },
      select: { timezone: true },
    });
    const p = localParts(this.clock.now(), b.timezone);
    return zonedInstant(p.year, p.month, p.day + 1, 0, b.timezone);
  }

  private async until(branchId: string, until: 'END_OF_DAY' | Date | null | undefined) {
    if (until === 'END_OF_DAY') return this.endOfDay(branchId);
    if (until instanceof Date && until <= this.clock.now())
      throw bad('until', 'Pick a time in the future.');
    return until ?? null;
  }

  /** API-RMENU-025 (FR-MENU-008) */
  async setItemAvailability(
    actorId: string,
    restaurantId: string,
    branchId: string,
    itemId: string,
    input: { available: boolean; until?: 'END_OF_DAY' | Date | null | undefined },
  ) {
    const until = input.available ? null : await this.until(branchId, input.until);
    await this.prisma.$transaction(async (tx) => {
      const item = await tx.foodItem.findFirst({
        where: { id: itemId, restaurantId, deletedAt: null },
      });
      if (!item) throw new AppError('ITEM_NOT_FOUND');
      await tx.branchItemAvailability.upsert({
        where: { branchId_foodItemId: { branchId, foodItemId: itemId } },
        create: {
          branchId,
          foodItemId: itemId,
          isAvailable: input.available,
          unavailableUntil: until,
          updatedBy: actorId,
        },
        update: { isAvailable: input.available, unavailableUntil: until, updatedBy: actorId },
      });
      await tx.branch.update({ where: { id: branchId }, data: { menuVersion: { increment: 1 } } });
      await this.log(
        tx,
        actorId,
        input.available ? 'menu.item_available' : 'menu.item_unavailable',
        'food_item',
        itemId,
        {
          branchId,
          until: until?.toISOString() ?? null,
        },
      );
    });
    return { itemId, branchId, available: input.available, unavailableUntil: until };
  }

  /** API-RMENU-026 */
  async setOptionAvailability(
    actorId: string,
    restaurantId: string,
    branchId: string,
    optionId: string,
    input: { available: boolean; until?: 'END_OF_DAY' | Date | null | undefined },
  ) {
    const until = input.available ? null : await this.until(branchId, input.until);
    await this.prisma.$transaction(async (tx) => {
      const o = await tx.customizationOption.findFirst({
        where: { id: optionId, deletedAt: null, group: { restaurantId } },
      });
      if (!o) throw new AppError('NOT_FOUND', { message: "We couldn't find that option." });
      await tx.branchOptionAvailability.upsert({
        where: { branchId_optionId: { branchId, optionId } },
        create: { branchId, optionId, isAvailable: input.available, unavailableUntil: until },
        update: { isAvailable: input.available, unavailableUntil: until },
      });
      await tx.branch.update({ where: { id: branchId }, data: { menuVersion: { increment: 1 } } });
      await this.log(
        tx,
        actorId,
        input.available ? 'menu.option_available' : 'menu.option_unavailable',
        'customization_option',
        optionId,
        {
          branchId,
        },
      );
    });
    return { optionId, branchId, available: input.available, unavailableUntil: until };
  }
}
