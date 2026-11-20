import type { OrderPriceComponentType, Prisma, PrismaClient } from '@fos/db';
import { uuidv7 } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import { writeOutbox } from '../../platform/outbox';
import { cartHash, type CheckoutService } from '../checkout';
import type { WalletService } from '../ledger';
import type { OffersService } from '../offers';
import type { PaymentsService, PaymentProvider } from '../payments';
import type { PricingConfigService, Quote } from '../pricing';
import { deliveryCode, deliveryCodeHash, newOrderNumber } from './order-number';
import type { OrderTimers } from './timers';

type Tx = Prisma.TransactionClient;

/**
 * FR-CHK-002 / FR-ORDER-001: turns an OPEN checkout session into exactly one
 * order (FR-ORDER-002: idempotency key + unique checkout_session_id + session
 * row lock). T01 (online → PAYMENT_PENDING) or T02 (COD / fully paid → PLACED).
 */
export class OrderCreationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly checkout: CheckoutService,
    private readonly offers: OffersService,
    private readonly wallet: WalletService,
    private readonly payments: PaymentsService,
    private readonly paymentProvider: PaymentProvider,
    private readonly pricingConfig: PricingConfigService,
    private readonly timers: OrderTimers,
    private readonly secret: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async confirm(userId: string, sessionId: string, expectedPayable: number) {
    const session = await this.checkout.owned(userId, sessionId);
    if (session.status === 'CONFIRMED') {
      const existing = await this.prisma.order.findUnique({
        where: { checkoutSessionId: session.id },
        select: { id: true },
      });
      throw new AppError('CHECKOUT_SESSION_CONSUMED', {
        details: existing ? [{ code: 'ORDER_ID', message: existing.id }] : [],
      });
    }
    if (session.status !== 'OPEN') throw new AppError('CHECKOUT_SESSION_EXPIRED');

    // Every check again, with current menu, prices, coupon and serviceability (FR-ORDER-001 1–7).
    const { evaluated, address } = await this.checkout.revalidate(userId, session);
    if (cartHash(evaluated) !== session.cartHash) {
      throw new AppError('CART_CHANGED', {
        message: 'Your cart changed since checkout started. Please review it.',
      });
    }
    const quote = evaluated.view.preview!;
    if (quote.payable !== expectedPayable) {
      // FR-PRICE-005: never charge an amount the customer didn't confirm.
      throw new AppError('PRICE_CHANGED', {
        message: `The total is now ₹${(quote.payable / 100).toFixed(2)} (was ₹${(expectedPayable / 100).toFixed(2)}). Please confirm the new total.`,
        details: [
          { code: 'EXPECTED_PAYABLE', message: String(expectedPayable) },
          { code: 'CURRENT_PAYABLE', message: String(quote.payable) },
        ],
      });
    }
    const branch = evaluated.branch!;
    const now = this.clock.now();
    const commission = await this.pricingConfig.commissionRateBps(branch.restaurantId, now);
    const taxRules = await this.pricingConfig.taxRules(now);
    const foodTaxBps = taxRules.find((t) => t.component === 'FOOD')?.rateBps ?? 0;
    const coupon = quote.discounts.find((d) => d.source === 'COUPON') ?? null;
    const immediate = session.paymentMethod !== 'ONLINE' || quote.payable === 0;

    const order = await this.prisma.$transaction(async (tx) => {
      // FR-ORDER-002 (c): the session moves OPEN → CONFIRMED exactly once.
      const [locked] = await tx.$queryRaw<{ status: string; expires_at: Date }[]>`
        SELECT status::text AS status, expires_at FROM checkout_sessions WHERE id = ${session.id}::uuid FOR UPDATE`;
      if (locked?.status !== 'OPEN') throw new AppError('CHECKOUT_SESSION_CONSUMED');
      if (locked.expires_at <= now) throw new AppError('CHECKOUT_SESSION_EXPIRED');

      await this.decrementStock(
        tx,
        branch.id,
        evaluated.priced.map((l) => ({
          foodItemId: l.resolved.item.id,
          quantity: l.quantity,
          name: l.resolved.name,
        })),
      );

      const orderId = uuidv7();
      const number = await this.uniqueNumber(tx, now);
      const code = deliveryCode(this.secret, orderId);
      const discountTotal =
        quote.discounts.reduce((s, d) => s + d.amount, 0) + quote.deliveryFeeWaived;
      const created = await tx.order.create({
        data: {
          id: orderId,
          number,
          userId,
          restaurantId: branch.restaurantId,
          branchId: branch.id,
          checkoutSessionId: session.id,
          status: immediate ? 'PLACED' : 'PAYMENT_PENDING',
          paymentMethod: session.paymentMethod,
          itemsSubtotalAmount: quote.itemsSubtotal,
          discountTotalAmount: discountTotal,
          feesTotalAmount:
            quote.packagingFee +
            quote.deliveryFee +
            quote.surgeFee +
            quote.smallOrderFee +
            quote.platformFee,
          taxTotalAmount: quote.taxTotal,
          tipAmount: quote.tip,
          walletAppliedAmount: quote.walletApplied,
          totalAmount: quote.total,
          payableAmount: quote.payable,
          feeScheduleId: quote.feeScheduleId,
          commissionRateBps: commission.rateBps,
          couponId: coupon?.id ?? null,
          deliveryOtpHash: deliveryCodeHash(this.secret, orderId, code),
          contactless: session.contactless,
          deliveryInstructions: session.deliveryInstructions,
          cookingInstructions: evaluated.cart.instructions,
          noCutlery: evaluated.cart.noCutlery,
          contactName: session.contactName ?? address.contactName,
          contactPhone: session.contactPhone ?? address.contactPhone,
          prepMinutes: branch.avgPrepMinutes14d ?? branch.defaultPrepMinutes,
          ...(immediate ? { placedAt: now } : {}),
          ...(evaluated.view.delivery
            ? {
                etaMinAt: new Date(now.getTime() + evaluated.view.delivery.eta.minMinutes * 60_000),
                etaMaxAt: new Date(now.getTime() + evaluated.view.delivery.eta.maxMinutes * 60_000),
              }
            : {}),
        },
      });

      // Immutable snapshots (orders keep what was charged even if the menu changes).
      for (const line of evaluated.priced) {
        const r = line.resolved;
        const priced = quote.lines.find((l) => l.lineId === line.lineId)!;
        await tx.orderItem.create({
          data: {
            orderId,
            foodItemId: r.item.id,
            itemName: r.name,
            variantName: r.variant?.name ?? null,
            dietaryMarker: r.dietaryMarker,
            unitPriceAmount: r.unitBaseAmount,
            optionsAmount: r.optionDeltaAmount,
            itemDiscountAmount: priced.itemDiscountAmount,
            quantity: line.quantity,
            lineTotalAmount: priced.lineAmount,
            taxRateBps: foodTaxBps,
            instructions:
              evaluated.cart.items.find((i) => i.id === line.lineId)?.instructions ?? null,
            options: {
              create: r.options.map((o) => ({
                optionId: o.id,
                groupName: o.groupName,
                optionName: o.name,
                priceDeltaAmount: o.priceDeltaAmount,
              })),
            },
          },
        });
      }
      await tx.orderPriceComponent.createMany({ data: priceComponents(orderId, quote) });
      await tx.$executeRaw`
        INSERT INTO order_addresses (order_id, line1, line2, landmark, area, city, state, pincode, location, source_address_id)
        VALUES (${orderId}::uuid, ${address.line1}, ${address.line2}, ${address.landmark}, ${address.area}, ${address.city},
          ${address.state}, ${address.pincode}, ST_SetSRID(ST_MakePoint(${address.location.lng}, ${address.location.lat}), 4326)::geography,
          ${address.id}::uuid)`;

      if (coupon)
        await this.offers.reserve(tx, {
          couponId: coupon.id,
          userId,
          orderId,
          discountAmount: coupon.amount,
        });
      if (quote.walletApplied > 0)
        await this.wallet.hold(tx, { userId, orderId, amount: quote.walletApplied });

      if (session.paymentMethod === 'COD') {
        // FR-PAY-011: a COD payment is PENDING until the partner collects it.
        await tx.payment.create({
          data: {
            orderId,
            method: 'COD',
            provider: 'NONE',
            amount: quote.payable,
            status: 'PENDING',
          },
        });
      } else if (!immediate) {
        await tx.payment.create({
          data: {
            orderId,
            method: 'ONLINE',
            provider: this.paymentProvider.name,
            amount: quote.payable,
            status: 'CREATED',
          },
        });
      }
      if (immediate) {
        // T02: nothing left to pay online — the coupon and wallet are consumed now.
        if (coupon) await this.offers.redeem(tx, orderId);
        if (quote.walletApplied > 0)
          await this.wallet.debit(tx, { userId, orderId, amount: quote.walletApplied });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: null,
          toStatus: created.status,
          actorType: 'CUSTOMER',
          actorId: userId,
          metadata: { transition: immediate ? 'T02' : 'T01' },
        },
      });
      await writeOutbox(tx, {
        aggregateType: 'order',
        aggregateId: orderId,
        aggregateVersion: 0,
        eventType: 'order.created',
        payload: { orderId, userId, branchId: branch.id, status: created.status },
      });
      await writeOutbox(tx, {
        aggregateType: 'order',
        aggregateId: orderId,
        aggregateVersion: 0,
        eventType: immediate ? 'order.placed' : 'order.payment_pending',
        payload: {
          orderId,
          userId,
          branchId: branch.id,
          from: null,
          to: created.status,
          transition: immediate ? 'T02' : 'T01',
        },
      });
      await tx.checkoutSession.update({
        where: { id: session.id },
        data: { status: 'CONFIRMED', version: { increment: 1 } },
      });
      await tx.cart.update({ where: { id: evaluated.cart.id }, data: { status: 'CONVERTED' } });
      return created;
    });

    await this.timers.afterCreate(order);
    let payment = null;
    let paymentError: string | null = null;
    if (order.status === 'PAYMENT_PENDING') {
      try {
        payment = await this.payments.initiate(userId, order.id);
      } catch (error) {
        // The order stays PAYMENT_PENDING; the customer can retry initiation (FR-CHK-002 step 5).
        paymentError = error instanceof AppError ? error.code : 'PAYMENT_PROVIDER_UNAVAILABLE';
        this.logger.warn(
          { err: error, orderId: order.id },
          'payment initiation after order creation failed',
        );
      }
    }
    return {
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        payableAmount: order.payableAmount,
        paymentMethod: order.paymentMethod,
      },
      payment,
      paymentError,
    };
  }

  /** BR-MENU-006: locks tracked stock rows, decrements, and refreshes the menu when anything runs out. */
  private async decrementStock(
    tx: Tx,
    branchId: string,
    lines: { foodItemId: string; quantity: number; name: string }[],
  ) {
    const wanted = new Map<string, { quantity: number; name: string }>();
    for (const l of lines)
      wanted.set(l.foodItemId, {
        quantity: (wanted.get(l.foodItemId)?.quantity ?? 0) + l.quantity,
        name: l.name,
      });
    const ids = [...wanted.keys()].sort();
    const rows = await tx.$queryRaw<{ food_item_id: string; quantity: number }[]>`
      SELECT food_item_id, quantity FROM branch_item_stock
      WHERE branch_id = ${branchId}::uuid AND food_item_id = ANY(${ids}::uuid[])
      ORDER BY food_item_id FOR UPDATE`;
    let soldOut = false;
    for (const row of rows) {
      const need = wanted.get(row.food_item_id)!;
      if (row.quantity < need.quantity) {
        throw new AppError('ITEM_UNAVAILABLE', {
          message:
            row.quantity <= 0
              ? `${need.name} just sold out.`
              : `Only ${row.quantity} left of ${need.name}.`,
          details: [
            { path: `items.${row.food_item_id}`, code: 'OUT_OF_STOCK', message: need.name },
          ],
        });
      }
      await tx.branchItemStock.update({
        where: { branchId_foodItemId: { branchId, foodItemId: row.food_item_id } },
        data: { quantity: { decrement: need.quantity }, version: { increment: 1 } },
      });
      if (row.quantity === need.quantity) soldOut = true;
    }
    if (rows.length > 0) {
      // Stock is part of the cached menu: any change bumps the version (FR-MENUC-008).
      await tx.branch.update({ where: { id: branchId }, data: { menuVersion: { increment: 1 } } });
      if (soldOut) this.logger.info({ branchId }, 'an item sold out');
    }
  }

  private async uniqueNumber(tx: Tx, now: Date): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const candidate = newOrderNumber(now);
      if (!(await tx.order.findUnique({ where: { number: candidate }, select: { id: true } })))
        return candidate;
    }
    throw new AppError('SERVICE_UNAVAILABLE', { message: 'Please try again.' });
  }
}

/** The charged breakdown, line by line (`order_price_components`). */
function priceComponents(orderId: string, q: Quote): Prisma.OrderPriceComponentCreateManyInput[] {
  const rows: Prisma.OrderPriceComponentCreateManyInput[] = [];
  const add = (
    type: OrderPriceComponentType,
    label: string,
    amount: number,
    extra: Partial<Prisma.OrderPriceComponentCreateManyInput> = {},
  ) => {
    if (amount !== 0 || type === 'ITEMS_SUBTOTAL')
      rows.push({ orderId, type, label, amount, fundedBy: 'CUSTOMER', ...extra });
  };
  add('ITEMS_SUBTOTAL', 'Items', q.itemsSubtotal);
  add('ITEM_DISCOUNT', 'Item discounts', q.itemDiscountTotal, { fundedBy: 'RESTAURANT' });
  for (const d of q.discounts) {
    const fundedBy =
      d.platformFundedAmount && d.restaurantFundedAmount
        ? 'SHARED'
        : d.restaurantFundedAmount
          ? 'RESTAURANT'
          : 'PLATFORM';
    add(
      d.source === 'COUPON' ? 'COUPON' : 'PROMOTION',
      d.label,
      d.freeDelivery ? q.deliveryFeeWaived : d.amount,
      { code: d.source === 'COUPON' ? d.label : null, fundedBy },
    );
  }
  add('PACKAGING', 'Packaging', q.packagingFee);
  add('DELIVERY_FEE', 'Delivery fee', q.deliveryFee + q.deliveryFeeWaived);
  add('SURGE', q.surgeReason ? `Surge (${q.surgeReason})` : 'Surge', q.surgeFee);
  add('SMALL_ORDER_FEE', 'Small order fee', q.smallOrderFee);
  add('PLATFORM_FEE', 'Platform fee', q.platformFee);
  for (const t of q.taxes)
    add('TAX', `${t.taxCode} on ${t.component.toLowerCase().replace(/_/g, ' ')}`, t.amount, {
      taxCode: t.taxCode as never,
      rateBps: t.rateBps,
      code: t.component,
    });
  return rows;
}
