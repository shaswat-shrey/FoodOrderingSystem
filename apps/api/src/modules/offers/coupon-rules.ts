import type { DiscountFunding, DiscountType, UserSegment } from '@fos/db';

/** Coupon codes are stored as typed and matched case-insensitively (FR-ADMIN-060). */
export const COUPON_CODE = /^[A-Z0-9]{4,20}$/;

/** The terms a coupon is checked and priced with (BR-COUPON-002…004, BR-COUPON-009). */
export interface CouponTerms {
  discountType: DiscountType;
  /** Paise for FLAT, basis points for PERCENT, 0 for FREE_DELIVERY. */
  value: number;
  maxDiscountAmount: number | null;
  minSubtotalAmount: number;
  startsAt: Date;
  endsAt: Date;
  usageLimitTotal: number | null;
  usageLimitPerUser: number;
  userSegment: UserSegment;
  funding: DiscountFunding;
  restaurantShareBps: number;
  /** How many restaurants / targeted users the coupon is scoped to. */
  restaurantCount: number;
  userCount: number;
}

/**
 * BR-COUPON-009: changing any of these on a coupon that has been redeemed
 * would re-price past orders' terms, so a new coupon is needed instead.
 */
export const COUPON_TERM_FIELDS = [
  'discountType',
  'value',
  'maxDiscountAmount',
  'minSubtotalAmount',
  'userSegment',
  'paymentMethodRestriction',
  'funding',
  'restaurantShareBps',
  'stackableWithPromotion',
  'restaurantIds',
  'zoneIds',
] as const;

export interface CouponTermIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * The rules a coupon must satisfy to be priced by the checkout engine:
 * percentage coupons carry a cap (BR-COUPON-004), free delivery has no value,
 * limits are consistent (BR-COUPON-003), restaurant-funded coupons name the
 * restaurants that fund them, targeted coupons name their customers.
 * Returns every problem, so an admin can fix them in one go.
 */
export function couponTermIssues(t: CouponTerms): CouponTermIssue[] {
  const issues: CouponTermIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });

  switch (t.discountType) {
    case 'PERCENT':
      if (t.value < 100 || t.value > 10_000)
        add('value', 'OUT_OF_RANGE', 'A percentage coupon is 1–100 % (100–10000 basis points).');
      if (t.maxDiscountAmount === null)
        add('maxDiscountAmount', 'REQUIRED', 'Percentage coupons need a maximum discount.');
      break;
    case 'FLAT':
      if (t.value < 100) add('value', 'OUT_OF_RANGE', 'A flat coupon is at least ₹1.');
      if (t.maxDiscountAmount !== null)
        add('maxDiscountAmount', 'NOT_ALLOWED', 'Only percentage coupons take a maximum discount.');
      if (t.minSubtotalAmount > 0 && t.value >= t.minSubtotalAmount)
        add('value', 'OUT_OF_RANGE', 'A flat discount must be below the minimum order.');
      break;
    case 'FREE_DELIVERY':
      if (t.value !== 0) add('value', 'NOT_ALLOWED', 'Free-delivery coupons have no value.');
      if (t.maxDiscountAmount !== null)
        add('maxDiscountAmount', 'NOT_ALLOWED', 'Only percentage coupons take a maximum discount.');
      break;
  }
  if (t.endsAt.getTime() <= t.startsAt.getTime())
    add('endsAt', 'BEFORE_START', 'The coupon must end after it starts.');
  if (t.usageLimitTotal !== null && t.usageLimitPerUser > t.usageLimitTotal)
    add('usageLimitPerUser', 'OUT_OF_RANGE', 'The per-customer limit exceeds the total limit.');
  if (t.userSegment === 'TARGETED' && t.userCount === 0)
    add('userIds', 'REQUIRED', 'Targeted coupons need at least one customer.');
  if (t.userSegment !== 'TARGETED' && t.userCount > 0)
    add('userIds', 'NOT_ALLOWED', 'Only targeted coupons list customers.');
  if (t.funding === 'PLATFORM' && t.restaurantShareBps !== 0)
    add('restaurantShareBps', 'NOT_ALLOWED', 'Platform-funded coupons have no restaurant share.');
  if (t.funding === 'RESTAURANT' && t.restaurantShareBps !== 10_000)
    add('restaurantShareBps', 'OUT_OF_RANGE', 'Restaurant-funded coupons are 100 % restaurant.');
  if (t.funding === 'SHARED' && (t.restaurantShareBps < 1 || t.restaurantShareBps > 9_999))
    add('restaurantShareBps', 'OUT_OF_RANGE', 'A shared coupon splits the cost (1–9999 bps).');
  if (t.funding !== 'PLATFORM' && t.restaurantCount === 0)
    add('restaurantIds', 'REQUIRED', 'Coupons funded by restaurants must name them.');
  return issues;
}
