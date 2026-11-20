import { money, percentOf } from '@fos/shared';

/**
 * Pricing engine (FR-PRICE-001, BR-PRICE-001…012, BR-COUPON-004/005).
 * A pure function: the same input always gives the same quote. All amounts are
 * integer paise; percentages are basis points rounded half-up once per component.
 */

export const PRICING_VERSION = 1;

export type Funding = 'PLATFORM' | 'RESTAURANT' | 'SHARED';
export type Component =
  'FOOD' | 'PACKAGING' | 'DELIVERY_FEE' | 'PLATFORM_FEE' | 'SMALL_ORDER_FEE' | 'SURGE_FEE';

export interface PricingLine {
  lineId: string;
  foodItemId: string;
  quantity: number;
  /** Variant price, or the item's base price (BR-MENU-004). */
  unitBaseAmount: number;
  /** Item-level discounted price, if lower (items without variants only). */
  unitDiscountedAmount: number | null;
  /** Σ selected option price deltas, per unit. */
  optionDeltaAmount: number;
  /** Item packaging override (PER_ITEM mode), else the branch amount. */
  packagingFeeAmount: number | null;
}

export interface FeeConfig {
  id: string;
  slabs: { fromM: number; toM: number; feeAmount: number }[];
  perKmBeyondSlabsAmount: number;
  platformFeeAmount: number;
  smallOrderThresholdAmount: number;
  smallOrderFeeAmount: number;
  packagingCapPerItemAmount: number;
  packagingCapPerOrderAmount: number;
  surgeCapAmount: number;
}

export interface TaxRuleInput {
  id: string;
  component: Component;
  taxCode: string;
  rateBps: number;
  collectedBy: 'PLATFORM' | 'RESTAURANT';
}

export interface PromotionInput {
  id: string;
  title: string;
  type: 'PERCENT_OFF' | 'FLAT_OFF' | 'FREE_DELIVERY' | 'BOGO';
  /** bps for PERCENT_OFF, paise for FLAT_OFF. */
  value: number;
  maxDiscountAmount: number | null;
  minSubtotalAmount: number;
  /** Restricts to these items; empty = whole cart. */
  foodItemIds: string[];
  funding: Funding;
}

export interface CouponInput {
  id: string;
  code: string;
  type: 'FLAT' | 'PERCENT' | 'FREE_DELIVERY';
  value: number;
  maxDiscountAmount: number | null;
  funding: Funding;
  restaurantShareBps: number;
  stackableWithPromotion: boolean;
  /** BR-COUPON-002: minimum subtotal after item discounts and the promotion. */
  minSubtotalAmount?: number;
}

export interface PricingInput {
  lines: PricingLine[];
  packaging: { mode: 'NONE' | 'PER_ITEM' | 'PER_ORDER'; amount: number };
  fees: FeeConfig;
  /** Road distance for the delivery fee (BR-GEO-003); null = no location yet. */
  roadDistanceM: number | null;
  /** Active zone surge, already capped (BR-PRICE-007). */
  surge: { amount: number; reason: string | null };
  taxRules: TaxRuleInput[];
  /** Eligible automatic promotions; the engine applies the best one (BR-COUPON-005). */
  promotions: PromotionInput[];
  /** Eligibility is checked by the coupon service; the engine only computes the discount. */
  coupon: CouponInput | null;
  tipAmount: number;
  wallet: { use: boolean; balance: number };
}

export interface DiscountLine {
  source: 'PROMOTION' | 'COUPON';
  id: string;
  label: string;
  /** Paise off the food subtotal; free-delivery benefits are reported in `deliveryFeeWaived`. */
  amount: number;
  freeDelivery: boolean;
  platformFundedAmount: number;
  restaurantFundedAmount: number;
}

export interface Quote {
  pricingVersion: number;
  feeScheduleId: string;
  lines: {
    lineId: string;
    unitAmount: number;
    quantity: number;
    lineAmount: number;
    itemDiscountAmount: number;
  }[];
  itemsSubtotal: number;
  itemDiscountTotal: number;
  discounts: DiscountLine[];
  /** Why the coupon was not applied on top of a promotion, if so (BR-COUPON-005). */
  couponNotice: string | null;
  /** How much more the customer must add for the coupon's minimum, when short (paise). */
  couponShortfall: number | null;
  packagingFee: number;
  deliveryFee: number;
  deliveryFeeWaived: number;
  deliveryFeeKnown: boolean;
  surgeFee: number;
  surgeReason: string | null;
  smallOrderFee: number;
  platformFee: number;
  taxes: {
    ruleId: string;
    component: Component;
    taxCode: string;
    rateBps: number;
    base: number;
    amount: number;
    collectedBy: string;
  }[];
  taxTotal: number;
  tip: number;
  total: number;
  walletApplied: number;
  payable: number;
}

const pct = (base: number, bps: number) => percentOf(money(Math.max(0, base)), bps).amount;

/** BR-PRICE-003 */
export function slabFee(
  distanceM: number,
  fees: Pick<FeeConfig, 'slabs' | 'perKmBeyondSlabsAmount'>,
): number {
  const slabs = [...fees.slabs].sort((a, b) => a.fromM - b.fromM);
  const hit = slabs.find((s) => distanceM >= s.fromM && distanceM < s.toM);
  if (hit) return hit.feeAmount;
  const last = slabs.at(-1);
  if (!last) return 0;
  if (distanceM < (slabs[0]?.fromM ?? 0)) return slabs[0]!.feeAmount;
  return last.feeAmount + Math.ceil((distanceM - last.toM) / 1000) * fees.perKmBeyondSlabsAmount;
}

function split(amount: number, funding: Funding, restaurantShareBps = 5000) {
  if (funding === 'PLATFORM') return { platformFundedAmount: amount, restaurantFundedAmount: 0 };
  if (funding === 'RESTAURANT') return { platformFundedAmount: 0, restaurantFundedAmount: amount };
  const restaurant = pct(amount, restaurantShareBps);
  return { platformFundedAmount: amount - restaurant, restaurantFundedAmount: restaurant };
}

export function computeQuote(input: PricingInput): Quote {
  // (1)–(3) lines, item-level discounts, items subtotal
  const lines = input.lines.map((l) => {
    const discounted = l.unitDiscountedAmount !== null && l.unitDiscountedAmount < l.unitBaseAmount;
    const unit = (discounted ? l.unitDiscountedAmount! : l.unitBaseAmount) + l.optionDeltaAmount;
    return {
      lineId: l.lineId,
      foodItemId: l.foodItemId,
      unitAmount: unit,
      quantity: l.quantity,
      lineAmount: unit * l.quantity,
      itemDiscountAmount: discounted
        ? (l.unitBaseAmount - l.unitDiscountedAmount!) * l.quantity
        : 0,
    };
  });
  const itemsSubtotal = lines.reduce((s, l) => s + l.lineAmount, 0);
  const itemDiscountTotal = lines.reduce((s, l) => s + l.itemDiscountAmount, 0);

  // (7) delivery fee before benefits — needed to value free-delivery offers
  const baseDeliveryFee =
    input.roadDistanceM === null ? 0 : slabFee(input.roadDistanceM, input.fees);

  // (4) best automatic promotion (by value to the customer)
  const promoValue = (p: PromotionInput) => {
    const eligible = lines.filter(
      (l) => p.foodItemIds.length === 0 || p.foodItemIds.includes(l.foodItemId),
    );
    const base = eligible.reduce((s, l) => s + l.lineAmount, 0);
    if (base === 0 || itemsSubtotal < p.minSubtotalAmount)
      return { amount: 0, freeDelivery: false, value: 0 };
    switch (p.type) {
      case 'PERCENT_OFF': {
        const raw = pct(base, p.value);
        const amount = Math.min(p.maxDiscountAmount ?? raw, raw, base);
        return { amount, freeDelivery: false, value: amount };
      }
      case 'FLAT_OFF': {
        const amount = Math.min(p.value, base);
        return { amount, freeDelivery: false, value: amount };
      }
      case 'BOGO': {
        const amount = Math.min(
          eligible.reduce((s, l) => s + Math.floor(l.quantity / 2) * l.unitAmount, 0),
          p.maxDiscountAmount ?? Number.MAX_SAFE_INTEGER,
        );
        return { amount, freeDelivery: false, value: amount };
      }
      case 'FREE_DELIVERY':
        return { amount: 0, freeDelivery: true, value: baseDeliveryFee };
    }
  };
  const bestPromo = input.promotions
    .map((p) => ({ p, ...promoValue(p) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value || a.p.id.localeCompare(b.p.id))[0];

  // (5) coupon on the subtotal after the promotion (BR-COUPON-002/004)
  const afterPromo = itemsSubtotal - (bestPromo?.amount ?? 0);
  const couponCalc = (c: CouponInput, base: number) => {
    if (c.type === 'FREE_DELIVERY')
      return { amount: 0, freeDelivery: true, value: baseDeliveryFee };
    const raw = c.type === 'FLAT' ? c.value : pct(base, c.value);
    const amount = Math.max(0, Math.min(raw, c.maxDiscountAmount ?? raw, base));
    return { amount, freeDelivery: false, value: amount };
  };
  let promo = bestPromo;
  let coupon = input.coupon
    ? { c: input.coupon, ...couponCalc(input.coupon, afterPromo) }
    : undefined;
  let couponNotice: string | null = null;
  if (coupon && promo && !coupon.c.stackableWithPromotion) {
    // Not stackable: keep whichever saves the customer more, and say so.
    const standalone = couponCalc(coupon.c, itemsSubtotal);
    if (standalone.value > promo.value) {
      coupon = { c: coupon.c, ...standalone };
      couponNotice = `${coupon.c.code} saves more than "${promo.p.title}", so the offer was replaced.`;
      promo = undefined;
    } else {
      couponNotice = `"${promo.p.title}" already saves more than ${coupon.c.code}; offers can't be combined.`;
      coupon = undefined;
    }
  }
  // Minimum spend is measured after the promotion that is actually applied.
  let couponShortfall: number | null = null;
  if (coupon) {
    const base = itemsSubtotal - (promo?.amount ?? 0);
    const min = coupon.c.minSubtotalAmount ?? 0;
    if (base < min) {
      couponShortfall = min - base;
      coupon = undefined;
    }
  }
  if (coupon && coupon.value === 0) coupon = undefined;

  const foodDiscount = (promo?.amount ?? 0) + (coupon?.amount ?? 0);
  const discounts: DiscountLine[] = [];
  if (promo) {
    const amount = promo.freeDelivery ? baseDeliveryFee : promo.amount;
    discounts.push({
      source: 'PROMOTION',
      id: promo.p.id,
      label: promo.p.title,
      amount: promo.amount,
      freeDelivery: promo.freeDelivery,
      ...split(amount, promo.p.funding),
    });
  }
  if (coupon) {
    const amount = coupon.freeDelivery ? baseDeliveryFee : coupon.amount;
    discounts.push({
      source: 'COUPON',
      id: coupon.c.id,
      label: coupon.c.code,
      amount: coupon.amount,
      freeDelivery: coupon.freeDelivery,
      ...split(amount, coupon.c.funding, coupon.c.restaurantShareBps),
    });
  }

  // (6) packaging (BR-PRICE-006)
  let packagingFee = 0;
  if (input.packaging.mode === 'PER_ITEM') {
    packagingFee = input.lines.reduce(
      (s, l) =>
        s +
        Math.min(
          l.packagingFeeAmount ?? input.packaging.amount,
          input.fees.packagingCapPerItemAmount,
        ) *
          l.quantity,
      0,
    );
  } else if (input.packaging.mode === 'PER_ORDER') {
    packagingFee = input.packaging.amount;
  }
  packagingFee = Math.min(packagingFee, input.fees.packagingCapPerOrderAmount);

  // (7) free-delivery benefits waive only the base fee (BR-PRICE-012); (8) surge
  const waived = promo?.freeDelivery || coupon?.freeDelivery ? baseDeliveryFee : 0;
  const deliveryFee = baseDeliveryFee - waived;
  const surgeFee = Math.min(input.surge.amount, input.fees.surgeCapAmount);

  // (9) small-order fee on the subtotal after discounts (BR-PRICE-004); (10) platform fee
  const foodAfterDiscounts = itemsSubtotal - foodDiscount;
  const smallOrderFee =
    itemsSubtotal > 0 && foodAfterDiscounts < input.fees.smallOrderThresholdAmount
      ? input.fees.smallOrderFeeAmount
      : 0;
  const platformFee = itemsSubtotal > 0 ? input.fees.platformFeeAmount : 0;

  // (11) taxes per component on post-discount bases (BR-PRICE-002, 009)
  const bases: Record<Component, number> = {
    FOOD: foodAfterDiscounts,
    PACKAGING: packagingFee,
    DELIVERY_FEE: deliveryFee,
    PLATFORM_FEE: platformFee,
    SMALL_ORDER_FEE: smallOrderFee,
    SURGE_FEE: surgeFee,
  };
  const taxes = input.taxRules
    .map((r) => ({
      ruleId: r.id,
      component: r.component,
      taxCode: r.taxCode,
      rateBps: r.rateBps,
      base: bases[r.component],
      amount: pct(bases[r.component], r.rateBps),
      collectedBy: r.collectedBy,
    }))
    .filter((t) => t.base > 0);
  const taxTotal = taxes.reduce((s, t) => s + t.amount, 0);

  // (12) tip, (13) wallet, (14) payable
  const tip = input.tipAmount;
  const total =
    foodAfterDiscounts +
    packagingFee +
    deliveryFee +
    surgeFee +
    smallOrderFee +
    platformFee +
    taxTotal +
    tip;
  const walletApplied = input.wallet.use ? Math.max(0, Math.min(input.wallet.balance, total)) : 0;

  return {
    pricingVersion: PRICING_VERSION,
    feeScheduleId: input.fees.id,
    lines: lines.map(({ foodItemId: _f, ...l }) => l),
    itemsSubtotal,
    itemDiscountTotal,
    discounts,
    couponNotice,
    couponShortfall,
    packagingFee,
    deliveryFee,
    deliveryFeeWaived: waived,
    deliveryFeeKnown: input.roadDistanceM !== null,
    surgeFee,
    surgeReason: surgeFee > 0 ? input.surge.reason : null,
    smallOrderFee,
    platformFee,
    taxes,
    taxTotal,
    tip,
    total,
    walletApplied,
    payable: total - walletApplied,
  };
}
