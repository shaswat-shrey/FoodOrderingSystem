import type { Order, OrderPriceComponent, Prisma } from '@fos/db';
import { money, percentOf } from '@fos/shared';
import type { AccountRef, LedgerService } from '../ledger';

type Tx = Prisma.TransactionClient;

export interface SettlementInput {
  components: Pick<OrderPriceComponent, 'type' | 'amount' | 'code'>[];
  /** Restaurant-funded part of promotions and coupons (from the quote; item discounts are always the restaurant's). */
  restaurantFundedDiscounts: number;
  /** Tax components (by `code` = priced component) the restaurant collects itself. */
  restaurantCollectedTaxComponents: ReadonlySet<string>;
  commissionRateBps: number;
  totalAmount: number;
  tipAmount: number;
}

export interface SettlementSplit {
  restaurant: number;
  commission: number;
  fees: number;
  platformPromo: number;
  platformTax: number;
  /** What the order's liability gives up (everything but the tip). */
  liability: number;
}

const sum = (cs: SettlementInput['components'], types: string[]) =>
  cs.filter((c) => types.includes(c.type)).reduce((s, c) => s + c.amount, 0);

/**
 * FR-SETTLE-001: how a delivered order's money divides.
 * restaurant = food − restaurant-funded discounts + packaging − commission (+ taxes it collects);
 * platform = commission + fees − platform-funded discounts; taxes the platform collects go to TAX_PAYABLE.
 * The tip is settled to the partner separately (delivery module).
 */
export function settlementSplit(input: SettlementInput): SettlementSplit {
  const c = input.components;
  const items = sum(c, ['ITEMS_SUBTOTAL']);
  const itemDiscounts = sum(c, ['ITEM_DISCOUNT']);
  const offers = sum(c, ['PROMOTION', 'COUPON']);
  const restaurantOffers = Math.min(input.restaurantFundedDiscounts, offers);
  const packaging = sum(c, ['PACKAGING']);
  const fees = sum(c, ['DELIVERY_FEE', 'SURGE', 'SMALL_ORDER_FEE', 'PLATFORM_FEE']);
  const taxes = c.filter((x) => x.type === 'TAX');
  const restaurantTax = taxes
    .filter((t) => input.restaurantCollectedTaxComponents.has(t.code ?? ''))
    .reduce((s, t) => s + t.amount, 0);
  const platformTax = taxes.reduce((s, t) => s + t.amount, 0) - restaurantTax;

  const foodNet = Math.max(0, items - itemDiscounts - restaurantOffers);
  const commission = percentOf(money(foodNet), input.commissionRateBps).amount;
  const split = {
    restaurant: foodNet + packaging - commission + restaurantTax,
    commission,
    fees,
    platformPromo: offers - restaurantOffers,
    platformTax,
    liability: input.totalAmount - input.tipAmount,
  };
  const charged =
    split.restaurant + split.commission + split.fees + split.platformTax - split.platformPromo;
  if (charged !== split.liability) {
    throw new Error(
      `settlement does not balance: components give ${charged}, order holds ${split.liability}`,
    );
  }
  return split;
}

/** Posts ORDER_SETTLEMENT for a DELIVERED order (idempotent through the ledger reference). */
export class OrderSettlement {
  constructor(private readonly ledger: LedgerService) {}

  async settle(tx: Tx, order: Order): Promise<{ duplicate: boolean; split: SettlementSplit }> {
    const [components, session] = await Promise.all([
      tx.orderPriceComponent.findMany({ where: { orderId: order.id } }),
      tx.checkoutSession.findUnique({
        where: { id: order.checkoutSessionId },
        select: { quote: true },
      }),
    ]);
    const quote = (session?.quote ?? {}) as {
      discounts?: { restaurantFundedAmount?: number }[];
      taxes?: { component: string; collectedBy: string }[];
    };
    const split = settlementSplit({
      components,
      restaurantFundedDiscounts: (quote.discounts ?? []).reduce(
        (s, d) => s + (d.restaurantFundedAmount ?? 0),
        0,
      ),
      restaurantCollectedTaxComponents: new Set(
        (quote.taxes ?? []).filter((t) => t.collectedBy === 'RESTAURANT').map((t) => t.component),
      ),
      commissionRateBps: order.commissionRateBps,
      totalAmount: order.totalAmount,
      tipAmount: order.tipAmount,
    });
    const platform = (type: AccountRef['type']): AccountRef => ({
      ownerType: 'PLATFORM',
      ownerId: null,
      type,
    });
    const posted = await this.ledger.post(tx, {
      type: 'ORDER_SETTLEMENT',
      referenceType: 'order',
      referenceId: order.id,
      description: `Settlement for order ${order.number}`,
      entries: [
        {
          ownerType: 'ORDER',
          ownerId: order.id,
          type: 'CUSTOMER_ORDER_LIABILITY',
          amount: split.liability,
        },
        {
          ownerType: 'RESTAURANT',
          ownerId: order.restaurantId,
          type: 'RESTAURANT_PAYABLE',
          amount: -split.restaurant,
        },
        { ...platform('PLATFORM_REVENUE_COMMISSION'), amount: -split.commission },
        { ...platform('PLATFORM_REVENUE_FEES'), amount: -split.fees },
        { ...platform('PLATFORM_PROMO_EXPENSE'), amount: split.platformPromo },
        { ...platform('TAX_PAYABLE'), amount: -split.platformTax },
      ],
    });
    return { duplicate: posted.duplicate, split };
  }
}
