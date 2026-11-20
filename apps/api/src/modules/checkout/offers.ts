import type { BranchRecord } from '../catalog';
import type { CouponInput, PromotionInput } from '../pricing';

/** Coupon problem reported on the cart (FR-CART-009/010). */
export interface CouponIssue {
  code: 'COUPON_INVALID' | 'COUPON_EXPIRED' | 'COUPON_NOT_APPLICABLE' | 'COUPON_LIMIT_REACHED';
  message: string;
}

export interface OfferContext {
  userId: string;
  branch: BranchRecord;
  /** Items subtotal after item discounts and before offers. */
  itemsSubtotal: number;
  foodItemIds: string[];
  paymentMethod: 'ONLINE' | 'COD' | 'WALLET' | null;
}

/** Supplies automatic promotions and the cart's coupon to pricing (implemented by the offers module). */
export interface OfferResolver {
  promotions(ctx: OfferContext): Promise<PromotionInput[]>;
  coupon(
    couponId: string,
    ctx: OfferContext,
  ): Promise<{ coupon: CouponInput | null; issue: CouponIssue | null }>;
}

export const noOffers: OfferResolver = {
  promotions: async () => [],
  coupon: async () => ({ coupon: null, issue: null }),
};
