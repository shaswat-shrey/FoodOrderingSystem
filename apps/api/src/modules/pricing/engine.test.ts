import { describe, expect, it } from 'vitest';
import {
  computeQuote,
  slabFee,
  type CouponInput,
  type PricingInput,
  type PromotionInput,
} from './engine';

const fees = {
  id: 'fs1',
  slabs: [
    { fromM: 0, toM: 2000, feeAmount: 1900 },
    { fromM: 2000, toM: 4000, feeAmount: 2900 },
    { fromM: 4000, toM: 6000, feeAmount: 3900 },
    { fromM: 6000, toM: 8000, feeAmount: 4900 },
  ],
  perKmBeyondSlabsAmount: 800,
  platformFeeAmount: 500,
  smallOrderThresholdAmount: 14900,
  smallOrderFeeAmount: 1500,
  packagingCapPerItemAmount: 1000,
  packagingCapPerOrderAmount: 5000,
  surgeCapAmount: 4000,
};
const taxRules = [
  { id: 't1', component: 'FOOD', taxCode: 'GST', rateBps: 500, collectedBy: 'PLATFORM' },
  { id: 't2', component: 'PACKAGING', taxCode: 'GST', rateBps: 500, collectedBy: 'PLATFORM' },
  { id: 't3', component: 'DELIVERY_FEE', taxCode: 'GST', rateBps: 1800, collectedBy: 'PLATFORM' },
  { id: 't4', component: 'PLATFORM_FEE', taxCode: 'GST', rateBps: 1800, collectedBy: 'PLATFORM' },
  {
    id: 't5',
    component: 'SMALL_ORDER_FEE',
    taxCode: 'GST',
    rateBps: 1800,
    collectedBy: 'PLATFORM',
  },
  { id: 't6', component: 'SURGE_FEE', taxCode: 'GST', rateBps: 1800, collectedBy: 'PLATFORM' },
] as PricingInput['taxRules'];

const lineA = {
  lineId: 'a',
  foodItemId: 'i1',
  quantity: 1,
  unitBaseAmount: 32900,
  unitDiscountedAmount: null,
  optionDeltaAmount: 0,
  packagingFeeAmount: null,
};
const lineB = {
  lineId: 'b',
  foodItemId: 'i2',
  quantity: 2,
  unitBaseAmount: 20000,
  unitDiscountedAmount: 18000,
  optionDeltaAmount: 3000,
  packagingFeeAmount: null,
};

function input(over: Partial<PricingInput> = {}): PricingInput {
  return {
    lines: [lineA, lineB],
    packaging: { mode: 'NONE', amount: 0 },
    fees,
    roadDistanceM: 2500,
    surge: { amount: 0, reason: null },
    taxRules,
    promotions: [],
    coupon: null,
    tipAmount: 2000,
    wallet: { use: false, balance: 0 },
    ...over,
  };
}
const coupon = (over: Partial<CouponInput>): CouponInput => ({
  id: 'c1',
  code: 'SAVE',
  type: 'FLAT',
  value: 10000,
  maxDiscountAmount: null,
  funding: 'PLATFORM',
  restaurantShareBps: 0,
  stackableWithPromotion: false,
  ...over,
});
const promo = (over: Partial<PromotionInput>): PromotionInput => ({
  id: 'p1',
  title: '20% off',
  type: 'PERCENT_OFF',
  value: 2000,
  maxDiscountAmount: 8000,
  minSubtotalAmount: 0,
  foodItemIds: [],
  funding: 'RESTAURANT',
  ...over,
});

describe('pricing engine (FR-PRICE-001, BR-PRICE-001…012)', () => {
  it('computes the reference breakdown', () => {
    const q = computeQuote(input());
    expect(q).toMatchObject({
      itemsSubtotal: 74_900, // 32 900 + 2 × (18 000 + 3 000)
      itemDiscountTotal: 4_000,
      deliveryFee: 2_900,
      smallOrderFee: 0,
      platformFee: 500,
      taxTotal: 4_357, // 3 745 food + 522 delivery + 90 platform
      tip: 2_000,
      total: 84_657,
      payable: 84_657,
    });
    expect(q.taxes.map((t) => [t.component, t.base, t.amount])).toEqual([
      ['FOOD', 74_900, 3_745],
      ['DELIVERY_FEE', 2_900, 522],
      ['PLATFORM_FEE', 500, 90],
    ]);
  });

  it('rounds each tax half-up once (BR-PRICE-002)', () => {
    const q = computeQuote(
      input({ lines: [{ ...lineA, unitBaseAmount: 1010 }], roadDistanceM: null, tipAmount: 0 }),
    );
    expect(q.taxes.find((t) => t.component === 'FOOD')!.amount).toBe(51); // 5 % of 1 010 = 50.5
  });

  it.each([
    ['PER_ITEM within caps', { mode: 'PER_ITEM' as const, amount: 800 }, 2_400],
    ['PER_ITEM capped per item', { mode: 'PER_ITEM' as const, amount: 1_500 }, 3_000],
    ['PER_ORDER capped per order', { mode: 'PER_ORDER' as const, amount: 9_000 }, 5_000],
    ['NONE', { mode: 'NONE' as const, amount: 900 }, 0],
  ])('packaging %s (BR-PRICE-006)', (_name, packaging, expected) => {
    expect(computeQuote(input({ packaging })).packagingFee).toBe(expected);
  });

  it('charges the small-order fee below the threshold after discounts (BR-PRICE-004)', () => {
    const small = input({ lines: [{ ...lineA, unitBaseAmount: 14_000 }] });
    expect(computeQuote(small).smallOrderFee).toBe(1_500);
    expect(
      computeQuote({ ...small, lines: [{ ...lineA, unitBaseAmount: 14_900 }] }).smallOrderFee,
    ).toBe(0);
    // A coupon can push the order below the threshold.
    expect(
      computeQuote({
        ...small,
        lines: [{ ...lineA, unitBaseAmount: 20_000 }],
        coupon: coupon({ value: 6_000 }),
      }).smallOrderFee,
    ).toBe(1_500);
  });

  it('caps percentage coupons and never exceeds the subtotal (BR-COUPON-004)', () => {
    const pctCoupon = coupon({ type: 'PERCENT', value: 5000, maxDiscountAmount: 10_000 });
    expect(computeQuote(input({ coupon: pctCoupon })).discounts[0]).toMatchObject({
      source: 'COUPON',
      amount: 10_000,
    });
    const tiny = computeQuote(
      input({ lines: [{ ...lineA, unitBaseAmount: 5_000 }], coupon: coupon({ value: 9_000 }) }),
    );
    expect(tiny.discounts[0]!.amount).toBe(5_000);
  });

  it('free delivery waives only the base fee; surge stays (BR-PRICE-012)', () => {
    const q = computeQuote(
      input({
        coupon: coupon({ type: 'FREE_DELIVERY', value: 0 }),
        surge: { amount: 2_000, reason: 'Rain' },
      }),
    );
    expect(q).toMatchObject({
      deliveryFee: 0,
      deliveryFeeWaived: 2_900,
      surgeFee: 2_000,
      surgeReason: 'Rain',
    });
    expect(q.taxes.some((t) => t.component === 'DELIVERY_FEE')).toBe(false);
    expect(q.discounts[0]).toMatchObject({ freeDelivery: true, platformFundedAmount: 2_900 });
  });

  it('caps surge at the schedule cap (BR-PRICE-007)', () => {
    expect(computeQuote(input({ surge: { amount: 9_000, reason: 'Demand' } })).surgeFee).toBe(
      4_000,
    );
  });

  it('applies the best promotion, and keeps the larger of promotion and non-stackable coupon (BR-COUPON-005)', () => {
    const promos = [
      promo({ id: 'p1', value: 1000 }),
      promo({ id: 'p2', type: 'FLAT_OFF', value: 9_000, title: '₹90 off' }),
    ];
    const onlyPromo = computeQuote(input({ promotions: promos }));
    expect(onlyPromo.discounts).toEqual([
      expect.objectContaining({ id: 'p2', amount: 9_000, restaurantFundedAmount: 9_000 }),
    ]);

    const smallCoupon = computeQuote(
      input({ promotions: promos, coupon: coupon({ value: 5_000 }) }),
    );
    expect(smallCoupon.discounts.map((d) => d.id)).toEqual(['p2']);
    expect(smallCoupon.couponNotice).toMatch(/already saves more/);

    const bigCoupon = computeQuote(
      input({ promotions: promos, coupon: coupon({ value: 20_000 }) }),
    );
    expect(bigCoupon.discounts.map((d) => d.id)).toEqual(['c1']);
    expect(bigCoupon.couponNotice).toMatch(/replaced/);

    const stacked = computeQuote(
      input({ promotions: promos, coupon: coupon({ value: 5_000, stackableWithPromotion: true }) }),
    );
    expect(stacked.discounts.map((d) => [d.id, d.amount])).toEqual([
      ['p2', 9_000],
      ['c1', 5_000],
    ]);
    expect(stacked.taxes.find((t) => t.component === 'FOOD')!.base).toBe(74_900 - 14_000);
  });

  it('respects promotion minimums and item scope, and BOGO gives every second unit free', () => {
    expect(
      computeQuote(input({ promotions: [promo({ minSubtotalAmount: 100_000 })] })).discounts,
    ).toEqual([]);
    const scoped = computeQuote(
      input({ promotions: [promo({ foodItemIds: ['i1'], maxDiscountAmount: null })] }),
    );
    expect(scoped.discounts[0]!.amount).toBe(6_580); // 20 % of 32 900
    const bogo = computeQuote(
      input({
        promotions: [
          promo({ type: 'BOGO', value: 0, foodItemIds: ['i2'], maxDiscountAmount: null }),
        ],
      }),
    );
    expect(bogo.discounts[0]!.amount).toBe(21_000); // one of two units of line b
  });

  it('applies a coupon minimum after the promotion and reports the shortfall (BR-COUPON-002)', () => {
    const minCoupon = coupon({
      value: 5_000,
      minSubtotalAmount: 70_000,
      stackableWithPromotion: true,
    });
    expect(computeQuote(input({ coupon: minCoupon })).couponShortfall).toBeNull(); // 74 900 ≥ 70 000
    const withPromo = computeQuote(
      input({ coupon: minCoupon, promotions: [promo({ type: 'FLAT_OFF', value: 9_000 })] }),
    );
    expect(withPromo.couponShortfall).toBe(4_100); // 74 900 − 9 000 = 65 900
    expect(withPromo.discounts.map((d) => d.source)).toEqual(['PROMOTION']);
  });

  it('splits shared funding by the restaurant share', () => {
    const q = computeQuote(
      input({ coupon: coupon({ value: 10_000, funding: 'SHARED', restaurantShareBps: 3000 }) }),
    );
    expect(q.discounts[0]).toMatchObject({
      platformFundedAmount: 7_000,
      restaurantFundedAmount: 3_000,
    });
  });

  it('applies wallet credit up to the total; tip is never taxed or discounted', () => {
    expect(computeQuote(input({ wallet: { use: true, balance: 10_000 } }))).toMatchObject({
      walletApplied: 10_000,
      payable: 74_657,
    });
    expect(computeQuote(input({ wallet: { use: true, balance: 999_999 } }))).toMatchObject({
      walletApplied: 84_657,
      payable: 0,
    });
    expect(computeQuote(input({ wallet: { use: false, balance: 10_000 } })).walletApplied).toBe(0);
    expect(computeQuote(input({ tipAmount: 0 })).taxTotal).toBe(computeQuote(input()).taxTotal);
  });

  it('reports an unknown delivery fee when there is no location yet', () => {
    expect(computeQuote(input({ roadDistanceM: null }))).toMatchObject({
      deliveryFee: 0,
      deliveryFeeKnown: false,
    });
  });

  it.each([
    [0, 1_900],
    [7_999, 4_900],
    [8_001, 5_700],
  ])('slab fee at %i m is %i', (d, fee) => expect(slabFee(d, fees)).toBe(fee));
});

describe('pricing invariants (property test, seeded)', () => {
  it('components always add up, nothing is negative, and results are deterministic', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let run = 0; run < 500; run++) {
      const lines = Array.from({ length: 1 + rand(5) }, (_, i) => {
        const base = 100 + rand(100_000);
        return {
          lineId: `l${i}`,
          foodItemId: `i${rand(4)}`,
          quantity: 1 + rand(20),
          unitBaseAmount: base,
          unitDiscountedAmount: rand(3) === 0 ? 100 + rand(base) : null,
          optionDeltaAmount: rand(5_000),
          packagingFeeAmount: rand(2) ? rand(2_000) : null,
        };
      });
      const i = input({
        lines,
        packaging: {
          mode: (['NONE', 'PER_ITEM', 'PER_ORDER'] as const)[rand(3)]!,
          amount: rand(3_000),
        },
        roadDistanceM: rand(4) ? rand(15_000) : null,
        surge: { amount: rand(6_000), reason: 'x' },
        promotions: rand(2)
          ? [
              promo({
                type: (['PERCENT_OFF', 'FLAT_OFF', 'FREE_DELIVERY', 'BOGO'] as const)[rand(4)]!,
                value: rand(9_000),
                maxDiscountAmount: rand(2) ? rand(20_000) : null,
              }),
            ]
          : [],
        coupon: rand(2)
          ? coupon({
              type: (['FLAT', 'PERCENT', 'FREE_DELIVERY'] as const)[rand(3)]!,
              value: rand(10_000),
              maxDiscountAmount: 15_000,
              stackableWithPromotion: Boolean(rand(2)),
            })
          : null,
        tipAmount: rand(50_001),
        wallet: { use: Boolean(rand(2)), balance: rand(200_000) },
      });
      const q = computeQuote(i);
      const discount = q.discounts.reduce((s, d) => s + d.amount, 0);
      expect(q.total).toBe(
        q.itemsSubtotal -
          discount +
          q.packagingFee +
          q.deliveryFee +
          q.surgeFee +
          q.smallOrderFee +
          q.platformFee +
          q.taxTotal +
          q.tip,
      );
      expect(q.payable).toBe(q.total - q.walletApplied);
      for (const v of [
        q.total,
        q.payable,
        q.walletApplied,
        q.deliveryFee,
        ...q.taxes.map((t) => t.amount),
        ...q.discounts.map((d) => d.amount),
      ]) {
        expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
      }
      expect(discount).toBeLessThanOrEqual(q.itemsSubtotal);
      expect(q.discounts.length).toBeLessThanOrEqual(2);
      expect(computeQuote(i)).toEqual(q);
    }
  });
});
