import type { Delivery, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { SettingsService } from '../config';
import type { LedgerService } from '../ledger';
import { cancellationPay, payTotal, tripPay, type Pay } from './pay';

type Tx = Prisma.TransactionClient;

/** Partner earnings: per-delivery pay, tips and cancellation compensation (FR-EARN-001, BR-EARN-001/002/007). */
export class PartnerEarningsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  private async plan(tx: Tx, zoneId: string) {
    const at = this.clock.now();
    const plan =
      (await tx.partnerPayPlan.findFirst({
        where: { zoneId, effectiveFrom: { lte: at } },
        orderBy: { effectiveFrom: 'desc' },
      })) ??
      (await tx.partnerPayPlan.findFirst({
        where: { zoneId: null, effectiveFrom: { lte: at } },
        orderBy: { effectiveFrom: 'desc' },
      }));
    if (!plan)
      throw new AppError('INTERNAL_ERROR', { message: 'No partner pay plan is configured.' });
    return plan;
  }

  private async trip(tx: Tx, d: Delivery) {
    const branch = await tx.branch.findUniqueOrThrow({
      where: { id: d.branchId },
      select: { zoneId: true, zone: { select: { surgeAmount: true, surgeUntil: true } } },
    });
    const roadFactor = await this.settings.get('geo.roadFactor');
    const now = this.clock.now();
    return {
      zoneId: branch.zoneId,
      facts: {
        dropRoadM: Math.round((d.distanceDropM ?? 0) * roadFactor),
        waitMinutes:
          d.arrivedRestaurantAt && d.pickedUpAt
            ? (d.pickedUpAt.getTime() - d.arrivedRestaurantAt.getTime()) / 60_000
            : 0,
        surge: Boolean(
          branch.zone.surgeAmount && branch.zone.surgeUntil && branch.zone.surgeUntil > now,
        ),
      },
    };
  }

  private async write(
    tx: Tx,
    d: Delivery,
    partnerId: string,
    payPlanId: string,
    pay: Pay,
    tip: number,
    label: string,
  ) {
    const existing = await tx.partnerEarning.findUnique({ where: { deliveryId: d.id } });
    if (existing) return existing;
    const total = payTotal(pay);
    const earning = await tx.partnerEarning.create({
      data: {
        partnerId,
        deliveryId: d.id,
        payPlanId,
        baseAmount: pay.base,
        distanceAmount: pay.distance,
        waitAmount: pay.wait,
        surgeAmount: pay.surge,
        tipAmount: tip,
        totalAmount: total + tip,
        createdAt: this.clock.now(),
      },
    });
    const payable = {
      ownerType: 'PARTNER' as const,
      ownerId: partnerId,
      type: 'PARTNER_PAYABLE' as const,
    };
    await this.ledger.post(tx, {
      type: 'PARTNER_EARNING',
      referenceType: 'delivery',
      referenceId: d.id,
      description: label,
      entries: [
        { ownerType: 'PLATFORM', ownerId: null, type: 'PLATFORM_DELIVERY_COST', amount: total },
        { ...payable, amount: -total },
      ],
    });
    // BR-EARN-002: the tip is the customer's money, passed on in full.
    if (tip > 0)
      await this.ledger.post(tx, {
        type: 'PARTNER_EARNING',
        referenceType: 'delivery',
        referenceId: d.id,
        idempotencyKey: 'tip',
        description: 'Tip from customer',
        entries: [
          { ownerType: 'ORDER', ownerId: d.orderId, type: 'CUSTOMER_ORDER_LIABILITY', amount: tip },
          { ...payable, amount: -tip },
        ],
      });
    return earning;
  }

  /** On delivery (FR-DEL-033): trip pay plus the tip. */
  async recordDelivered(tx: Tx, d: Delivery) {
    if (!d.partnerId) return null;
    const { zoneId, facts } = await this.trip(tx, d);
    const plan = await this.plan(tx, zoneId);
    const order = await tx.order.findUniqueOrThrow({
      where: { id: d.orderId },
      select: { tipAmount: true, number: true },
    });
    return this.write(
      tx,
      d,
      d.partnerId,
      plan.id,
      tripPay(plan, facts),
      order.tipAmount,
      `Delivery ${order.number}`,
    );
  }

  /** BR-EARN-007: the order was cancelled after the partner accepted (not their fault). */
  async compensate(tx: Tx, d: Delivery, stage: 'BEFORE_PICKUP' | 'AFTER_PICKUP') {
    if (!d.partnerId) return null;
    const { zoneId, facts } = await this.trip(tx, d);
    const plan = await this.plan(tx, zoneId);
    const pay = cancellationPay(plan, { stage, travelledM: d.distancePickupM ?? 0, trip: facts });
    return this.write(tx, d, d.partnerId, plan.id, pay, 0, 'Cancelled trip compensation');
  }

  /** Estimate shown on offers (FR-DEL-001). */
  async estimate(d: Delivery) {
    return this.prisma.$transaction(async (tx) => {
      const { zoneId, facts } = await this.trip(tx, d);
      return payTotal(tripPay(await this.plan(tx, zoneId), facts));
    });
  }
}
