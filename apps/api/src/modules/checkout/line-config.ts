import { createHash } from 'node:crypto';
import type { DietaryMarker } from '@fos/db';
import type { ApiErrorDetail } from '@fos/types';
import { blocked, type RawItem, type RawMenu } from '../catalog';

export interface LineRequest {
  foodItemId: string;
  variantId?: string | undefined;
  optionIds: string[];
  quantity: number;
  instructions?: string | undefined;
}

export interface ResolvedLine {
  item: RawItem;
  name: string;
  dietaryMarker: DietaryMarker;
  variant: { id: string; name: string } | null;
  options: {
    id: string;
    name: string;
    groupId: string;
    groupName: string;
    priceDeltaAmount: number;
  }[];
  unitBaseAmount: number;
  unitDiscountedAmount: number | null;
  optionDeltaAmount: number;
  /** What the customer pays per unit (FR-CART-002). */
  unitAmount: number;
  packagingFeeAmount: number | null;
}

export type LineProblemCode =
  | 'ITEM_NOT_IN_BRANCH'
  | 'ITEM_UNAVAILABLE'
  | 'VARIANT_REQUIRED'
  | 'CUSTOMIZATION_INVALID'
  | 'OPTION_UNAVAILABLE';

export type LineResult =
  | ({ ok: true } & ResolvedLine)
  | {
      ok: false;
      code: LineProblemCode;
      message: string;
      details: ApiErrorDetail[];
      item: RawItem | null;
    };

/** BR-CART-004: line identity = item, variant, sorted options, instructions. */
export function configHash(
  req: Pick<LineRequest, 'foodItemId' | 'variantId' | 'optionIds' | 'instructions'>,
): string {
  const key = JSON.stringify([
    req.foodItemId,
    req.variantId ?? '',
    [...new Set(req.optionIds)].sort(),
    (req.instructions ?? '').trim(),
  ]);
  return createHash('sha256').update(key).digest('hex');
}

const fail = (
  code: LineProblemCode,
  message: string,
  item: RawItem | null,
  details: ApiErrorDetail[] = [],
): LineResult => ({
  ok: false,
  code,
  message,
  details,
  item,
});

/**
 * FR-CART-001 step 2 against the branch's current menu: item on the menu and
 * available (BR-MENU-007, stock), variant required/valid (BR-MENU-004), every
 * option from a group attached to the item or the chosen variant, group min/max
 * and required groups (BR-MENU-003), option availability. Branch open/closed is
 * checked by the caller (warn on add, block at checkout).
 */
export function resolveLine(menu: RawMenu, req: LineRequest, now: Date): LineResult {
  const item = menu.items.find((i) => i.id === req.foodItemId);
  if (!item) return fail('ITEM_NOT_IN_BRANCH', "This dish isn't on this restaurant's menu.", null);
  if (blocked(item.availability, now))
    return fail('ITEM_UNAVAILABLE', `${item.name} isn't available right now.`, item);
  if (item.stock !== null && item.stock < req.quantity) {
    return fail(
      'ITEM_UNAVAILABLE',
      item.stock <= 0 ? `${item.name} is sold out.` : `Only ${item.stock} left of ${item.name}.`,
      item,
    );
  }

  let variant: RawItem['variants'][number] | null = null;
  if (item.variants.length > 0) {
    if (!req.variantId) return fail('VARIANT_REQUIRED', `Choose a size for ${item.name}.`, item);
    variant = item.variants.find((v) => v.id === req.variantId) ?? null;
    if (!variant) {
      return fail('CUSTOMIZATION_INVALID', "That size isn't available for this dish.", item, [
        { path: 'variantId', code: 'UNKNOWN_VARIANT', message: 'Unknown variant' },
      ]);
    }
  } else if (req.variantId) {
    return fail('CUSTOMIZATION_INVALID', "This dish doesn't come in sizes.", item, [
      { path: 'variantId', code: 'UNKNOWN_VARIANT', message: 'This item has no variants' },
    ]);
  }

  const groups = item.groups.filter((g) => g.variantId === null || g.variantId === variant?.id);
  const details: ApiErrorDetail[] = [];
  const chosen = [...new Set(req.optionIds)];
  if (chosen.length !== req.optionIds.length)
    details.push({ path: 'optionIds', code: 'DUPLICATE_OPTION', message: 'Each option once' });
  const options: ResolvedLine['options'] = [];
  for (const optionId of chosen) {
    const group = groups.find((g) => g.options.some((o) => o.id === optionId));
    const option = group?.options.find((o) => o.id === optionId);
    if (!group || !option) {
      details.push({
        path: `optionIds`,
        code: 'UNKNOWN_OPTION',
        message: `Option ${optionId} is not offered for this dish`,
      });
      continue;
    }
    if (blocked(option.availability, now)) {
      return fail('OPTION_UNAVAILABLE', `${option.name} isn't available right now.`, item, [
        {
          path: `groups.${group.id}`,
          code: 'OPTION_UNAVAILABLE',
          message: `${option.name} is unavailable`,
        },
      ]);
    }
    options.push({
      id: option.id,
      name: option.name,
      groupId: group.id,
      groupName: group.name,
      priceDeltaAmount: option.priceDeltaAmount,
    });
  }
  for (const g of groups) {
    const count = options.filter((o) => o.groupId === g.id).length;
    if (count < g.minSelect) {
      details.push({
        path: `groups.${g.id}`,
        code: 'MIN_SELECT',
        message:
          g.minSelect === 1 ? `Choose ${g.name}` : `Choose at least ${g.minSelect} for ${g.name}`,
      });
    }
    if (count > g.maxSelect)
      details.push({
        path: `groups.${g.id}`,
        code: 'MAX_SELECT',
        message: `Choose at most ${g.maxSelect} for ${g.name}`,
      });
  }
  if (details.length > 0)
    return fail('CUSTOMIZATION_INVALID', 'Please check your choices for this dish.', item, details);

  const unitBaseAmount = variant ? variant.priceAmount : item.basePriceAmount;
  const unitDiscountedAmount =
    !variant &&
    item.discountedPriceAmount !== null &&
    item.discountedPriceAmount < item.basePriceAmount
      ? item.discountedPriceAmount
      : null;
  const optionDeltaAmount = options.reduce((s, o) => s + o.priceDeltaAmount, 0);
  return {
    ok: true,
    item,
    name: item.name,
    dietaryMarker: item.dietaryMarker,
    variant: variant ? { id: variant.id, name: variant.name } : null,
    options,
    unitBaseAmount,
    unitDiscountedAmount,
    optionDeltaAmount,
    unitAmount: (unitDiscountedAmount ?? unitBaseAmount) + optionDeltaAmount,
    packagingFeeAmount: item.packagingFeeAmount,
  };
}
