import { describe, expect, it } from 'vitest';
import { settlementSplit } from './settlement';

const c = (type: string, amount: number, code: string | null = null) => ({
  type: type as never,
  amount,
  code,
});

describe('settlement split (FR-SETTLE-001)', () => {
  it('divides a delivered order between restaurant, platform and tax, tip aside', () => {
    // ₹600 food, ₹50 item discount, ₹100 coupon (₹40 restaurant-funded), ₹20 packaging,
    // ₹30 delivery, ₹10 platform fee, 5% GST on food+packaging and 18% on fees, ₹25 tip.
    const components = [
      c('ITEMS_SUBTOTAL', 60_000),
      c('ITEM_DISCOUNT', 5_000),
      c('COUPON', 10_000),
      c('PACKAGING', 2_000),
      c('DELIVERY_FEE', 3_000),
      c('PLATFORM_FEE', 1_000),
      c('TAX', 2_350, 'FOOD'),
      c('TAX', 100, 'PACKAGING'),
      c('TAX', 720, 'DELIVERY_FEE'),
    ];
    const total = 60_000 - 5_000 - 10_000 + 2_000 + 3_000 + 1_000 + 2_350 + 100 + 720 + 2_500;
    const split = settlementSplit({
      components,
      restaurantFundedDiscounts: 4_000,
      restaurantCollectedTaxComponents: new Set(),
      commissionRateBps: 2000,
      totalAmount: total,
      tipAmount: 2_500,
    });
    // Food net of restaurant-funded discounts: 60 000 − 5 000 − 4 000 = 51 000; commission 20 %.
    expect(split).toEqual({
      restaurant: 51_000 + 2_000 - 10_200,
      commission: 10_200,
      fees: 4_000,
      platformPromo: 6_000,
      platformTax: 3_170,
      liability: total - 2_500,
    });
  });

  it('pays taxes the restaurant collects to the restaurant, and refuses an unbalanced order', () => {
    const components = [c('ITEMS_SUBTOTAL', 10_000), c('TAX', 500, 'FOOD')];
    expect(
      settlementSplit({
        components,
        restaurantFundedDiscounts: 0,
        restaurantCollectedTaxComponents: new Set(['FOOD']),
        commissionRateBps: 1000,
        totalAmount: 10_500,
        tipAmount: 0,
      }),
    ).toMatchObject({ restaurant: 10_000 - 1_000 + 500, platformTax: 0 });
    expect(() =>
      settlementSplit({
        components,
        restaurantFundedDiscounts: 0,
        restaurantCollectedTaxComponents: new Set(),
        commissionRateBps: 1000,
        totalAmount: 11_000,
        tipAmount: 0,
      }),
    ).toThrow(/does not balance/);
  });
});
