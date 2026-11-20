import type { Clock } from '../../platform/clock';
import {
  surgeFor,
  type BranchRecord,
  type DeliveryInfo,
  type ServiceabilityService,
} from '../catalog';
import type { LatLng, RoutingProvider } from '../geo';
import {
  computeQuote,
  type CouponInput,
  type PricingConfigService,
  type PromotionInput,
  type Quote,
} from '../pricing';
import type { ResolvedLine } from './line-config';

export interface QuoteContext {
  branch: BranchRecord;
  lines: { lineId: string; quantity: number; resolved: ResolvedLine }[];
  /** Delivery location; null prices without a delivery fee (FR-CART-008). */
  point: LatLng | null;
  tipAmount: number;
  promotions: PromotionInput[];
  coupon: CouponInput | null;
  wallet: { use: boolean; balance: number };
}

export interface QuoteResult {
  quote: Quote;
  /** Serviceability and ETA for the location, when one was given. */
  delivery: DeliveryInfo | null;
}

/** Collects every pricing input from configuration and calls the pure engine (FR-PRICE-001). */
export class QuoteBuilder {
  constructor(
    private readonly serviceability: ServiceabilityService,
    private readonly routing: RoutingProvider,
    private readonly config: PricingConfigService,
    private readonly clock: Clock,
  ) {}

  async build(ctx: QuoteContext): Promise<QuoteResult> {
    const now = this.clock.now();
    const { branch, point } = ctx;
    const [fees, taxRules] = await Promise.all([
      this.serviceability.feeSchedule(branch.zoneId),
      this.config.taxRules(now),
    ]);
    let delivery: DeliveryInfo | null = null;
    let roadDistanceM: number | null = null;
    if (point) {
      const [zone, straight, route] = await Promise.all([
        this.serviceability.zoneAt(point),
        this.serviceability.straightLineM(branch.id, point),
        this.routing.route(branch.point, point),
      ]);
      delivery = await this.serviceability.deliveryInfo(
        branch,
        point,
        straight,
        zone?.status === 'ACTIVE' ? zone.id : null,
      );
      roadDistanceM = route.distanceM;
    }
    const quote = computeQuote({
      lines: ctx.lines.map((l) => ({
        lineId: l.lineId,
        foodItemId: l.resolved.item.id,
        quantity: l.quantity,
        unitBaseAmount: l.resolved.unitBaseAmount,
        unitDiscountedAmount: l.resolved.unitDiscountedAmount,
        optionDeltaAmount: l.resolved.optionDeltaAmount,
        packagingFeeAmount: l.resolved.packagingFeeAmount,
      })),
      packaging: { mode: branch.packagingFeeMode, amount: branch.packagingFeeAmount },
      fees,
      roadDistanceM,
      surge: surgeFor(branch.zone, fees.surgeCapAmount, now),
      taxRules,
      promotions: ctx.promotions,
      coupon: ctx.coupon,
      tipAmount: ctx.tipAmount,
      wallet: ctx.wallet,
    });
    return { quote, delivery };
  }
}
