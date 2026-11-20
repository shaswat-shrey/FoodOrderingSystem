import type { LedgerAccountType, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import type { FieldCipher } from '../../platform/crypto';
import { AppError } from '../../platform/http/errors';
import { decodeCursor, encodeCursor, queryFingerprint } from '../../platform/pagination';
import type { AuditService } from '../audit';
import { localParts, zonedInstant } from '../catalog';
import type { SettingsService } from '../config';
import type { PartnerAvailabilityService } from './availability.service';

const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;
export type EarningsPeriod = 'day' | 'week' | 'month';

/** Local calendar bounds (IST) of the day, Monday–Sunday week (BR-EARN-004) or month holding `at`. */
export function periodBounds(period: EarningsPeriod, at: Date): { from: Date; to: Date } {
  const p = localParts(at, TZ);
  if (period === 'month') {
    const next = p.month === 12 ? [p.year + 1, 1] : [p.year, p.month + 1];
    return {
      from: zonedInstant(p.year, p.month, 1, 0, TZ),
      to: zonedInstant(next[0]!, next[1]!, 1, 0, TZ),
    };
  }
  const day = zonedInstant(p.year, p.month, p.day, 0, TZ);
  if (period === 'day') return { from: day, to: new Date(day.getTime() + DAY) };
  const from = new Date(day.getTime() - ((p.weekday + 6) % 7) * DAY);
  return { from, to: new Date(from.getTime() + 7 * DAY) };
}

const dateKey = (d: Date) => {
  const p = localParts(d, TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

type Page = { limit: number; cursor?: string | undefined };

/** Implemented by the reviews module (kept structural so partners does not depend on it). */
export interface PartnerRatings {
  partnerSummary(partnerId: string): Promise<unknown>;
}

/**
 * What a partner sees about their money and performance (API-EARN-001…003, 005…011)
 * and the bank-change request (API-EARN-012). Amounts are paise.
 */
export class PartnerFinanceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly availability: PartnerAvailabilityService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly cipher: FieldCipher,
    private readonly reviews: PartnerRatings,
    private readonly clock: Clock,
  ) {}

  private async partnerId(userId: string) {
    return (await this.availability.partnerFor(userId)).id;
  }

  /** A page of entries on one of the partner's ledger accounts, newest first. */
  private async statement(
    partnerId: string,
    type: LedgerAccountType,
    page: Page & { from?: Date | undefined; to?: Date | undefined },
  ) {
    const context = queryFingerprint(['partner-ledger', partnerId, type, page.from, page.to]);
    const after = page.cursor ? decodeCursor(page.cursor, context) : null;
    const account = await this.prisma.ledgerAccount.findFirst({
      where: { ownerType: 'PARTNER', ownerId: partnerId, type },
      select: { id: true },
    });
    if (!account) return { rows: [], nextCursor: null };
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        accountId: account.id,
        createdAt: {
          ...(page.from ? { gte: page.from } : {}),
          ...(page.to ? { lt: page.to } : {}),
        },
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after[0] as number) } },
                { createdAt: new Date(after[0] as number), id: { lt: after[1] as string } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      include: {
        transaction: {
          select: {
            type: true,
            description: true,
            referenceType: true,
            referenceId: true,
            idempotencyKey: true,
          },
        },
      },
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      rows: items,
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }

  /** API-EARN-001 (FR-EARN-002): totals and breakdown for a day, week or month. */
  async summary(userId: string, period: EarningsPeriod, date?: Date) {
    const partnerId = await this.partnerId(userId);
    const { from, to } = periodBounds(period, date ?? this.clock.now());
    const [earnings, others] = await Promise.all([
      this.prisma.partnerEarning.findMany({
        where: { partnerId, createdAt: { gte: from, lt: to } },
        include: { delivery: { select: { status: true, distanceDropM: true } } },
      }),
      this.prisma.ledgerEntry.findMany({
        where: {
          account: { ownerType: 'PARTNER', ownerId: partnerId, type: 'PARTNER_PAYABLE' },
          createdAt: { gte: from, lt: to },
          transaction: { type: { in: ['ADJUSTMENT', 'INCENTIVE'] } },
        },
        include: { transaction: { select: { type: true } } },
      }),
    ]);
    const sum = (f: (e: (typeof earnings)[number]) => number) =>
      earnings.reduce((s, e) => s + f(e), 0);
    const credit = (type: string) =>
      others.filter((o) => o.transaction.type === type).reduce((s, o) => s - Number(o.amount), 0);
    const delivered = earnings.filter((e) => e.delivery.status === 'DELIVERED');
    const tripPay = sum((e) => e.totalAmount - e.tipAmount);
    const tips = sum((e) => e.tipAmount);
    const adjustments = credit('ADJUSTMENT');
    const incentives = credit('INCENTIVE');
    const days = new Map<string, { date: string; deliveries: number; amount: number }>();
    for (const e of earnings) {
      const key = dateKey(e.createdAt);
      const d = days.get(key) ?? { date: key, deliveries: 0, amount: 0 };
      d.amount += e.totalAmount;
      if (e.delivery.status === 'DELIVERED') d.deliveries += 1;
      days.set(key, d);
    }
    return {
      period,
      from,
      to,
      deliveries: delivered.length,
      cancelledTrips: earnings.length - delivered.length,
      distanceKm:
        Math.round(delivered.reduce((s, e) => s + (e.delivery.distanceDropM ?? 0), 0) / 100) / 10,
      breakdown: {
        base: sum((e) => e.baseAmount),
        distance: sum((e) => e.distanceAmount),
        wait: sum((e) => e.waitAmount),
        surge: sum((e) => e.surgeAmount),
        tips,
        incentives,
        adjustments,
      },
      tripPay,
      total: tripPay + tips + incentives + adjustments,
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  /** API-EARN-002: everything credited or debited to the partner's earnings, newest first. */
  async entries(userId: string, page: Page & { from?: Date | undefined; to?: Date | undefined }) {
    const partnerId = await this.partnerId(userId);
    const { rows, nextCursor } = await this.statement(partnerId, 'PARTNER_PAYABLE', page);
    const deliveryIds = rows
      .filter((r) => r.transaction.referenceType === 'delivery')
      .map((r) => r.transaction.referenceId);
    const orders = new Map(
      (
        await this.prisma.delivery.findMany({
          where: { id: { in: deliveryIds } },
          select: { id: true, order: { select: { number: true } } },
        })
      ).map((d) => [d.id, d.order.number]),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.transaction.idempotencyKey === 'tip' ? 'TIP' : r.transaction.type,
        description: r.transaction.description,
        amount: -Number(r.amount),
        deliveryId: r.transaction.referenceType === 'delivery' ? r.transaction.referenceId : null,
        orderNumber: orders.get(r.transaction.referenceId) ?? null,
        createdAt: r.createdAt,
      })),
      nextCursor,
    };
  }

  /** API-EARN-003 (FR-EARN-001): how one delivery's pay was worked out. */
  async delivery(userId: string, deliveryId: string) {
    const partnerId = await this.partnerId(userId);
    const e = await this.prisma.partnerEarning.findFirst({
      where: { deliveryId, partnerId },
      include: {
        delivery: {
          select: {
            status: true,
            distancePickupM: true,
            distanceDropM: true,
            arrivedRestaurantAt: true,
            pickedUpAt: true,
            deliveredAt: true,
            order: { select: { number: true } },
            branch: { select: { name: true, restaurant: { select: { brandName: true } } } },
          },
        },
      },
    });
    if (!e) throw new AppError('NOT_FOUND', { message: 'No earnings for this delivery.' });
    const d = e.delivery;
    return {
      deliveryId,
      orderNumber: d.order.number,
      restaurant: `${d.branch.restaurant.brandName}, ${d.branch.name}`,
      status: d.status,
      compensation: d.status !== 'DELIVERED',
      distanceKm: Math.round((d.distanceDropM ?? 0) / 100) / 10,
      waitMinutes:
        d.arrivedRestaurantAt && d.pickedUpAt
          ? Math.round((d.pickedUpAt.getTime() - d.arrivedRestaurantAt.getTime()) / 60_000)
          : 0,
      deliveredAt: d.deliveredAt,
      breakdown: {
        base: e.baseAmount,
        distance: e.distanceAmount,
        wait: e.waitAmount,
        surge: e.surgeAmount,
        tip: e.tipAmount,
      },
      total: e.totalAmount,
      createdAt: e.createdAt,
    };
  }

  /** API-EARN-005 (FR-EARN-005, BR-DEL-010): cash held against the cap. */
  async cash(userId: string) {
    const partnerId = await this.partnerId(userId);
    const [balance, cap] = await Promise.all([
      this.availability.cashInHand(partnerId),
      this.settings.get('partner.cashCapAmount'),
    ]);
    return {
      balance,
      cap,
      remaining: Math.max(0, cap - balance),
      blocked: balance >= cap,
      howToDeposit:
        'Deposit at a partner hub or pay by UPI to the platform; it is also deducted from your next payout.',
    };
  }

  /** API-EARN-006: cash collected on COD orders and deposits made (amount > 0 = cash you now hold). */
  async cashTransactions(userId: string, page: Page) {
    const partnerId = await this.partnerId(userId);
    const { rows, nextCursor } = await this.statement(partnerId, 'PARTNER_CASH_IN_HAND', page);
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.transaction.type,
        description: r.transaction.description,
        amount: Number(r.amount),
        createdAt: r.createdAt,
      })),
      nextCursor,
    };
  }

  /** BR-EARN-006: earnings − unremitted cash; payouts below the minimum roll over (BR-EARN-005). */
  private async nextPayout(partnerId: string) {
    const [payable, cash, minimum, pendingBank] = await Promise.all([
      this.prisma.ledgerAccount.findFirst({
        where: { ownerType: 'PARTNER', ownerId: partnerId, type: 'PARTNER_PAYABLE' },
        select: { balance: true },
      }),
      this.availability.cashInHand(partnerId),
      this.settings.get('partner.minPayoutAmount'),
      this.prisma.partnerBankAccount.count({
        where: { partnerId, status: 'PENDING_VERIFICATION' },
      }),
    ]);
    // PARTNER_PAYABLE is credit-normal and stored on its normal side: a positive balance is owed to the partner.
    const earned = Number(payable?.balance ?? 0n);
    const amount = earned - cash;
    const week = periodBounds('week', this.clock.now());
    return {
      periodStart: week.from,
      periodEnd: week.to,
      earnings: earned,
      cashDeduction: cash,
      amount,
      minimum,
      status:
        pendingBank > 0
          ? 'ON_HOLD_BANK_CHANGE'
          : amount < 0
            ? 'CARRY_OVER_NEGATIVE'
            : amount < minimum
              ? 'BELOW_MINIMUM'
              : 'SCHEDULED',
    };
  }

  /** API-EARN-007 (FR-EARN-006): payout history plus the next payout estimate. */
  async payouts(userId: string, page: Page) {
    const partnerId = await this.partnerId(userId);
    const context = queryFingerprint(['partner-payouts', partnerId]);
    const after = page.cursor ? decodeCursor(page.cursor, context) : null;
    const rows = await this.prisma.payout.findMany({
      where: {
        partnerId,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after[0] as number) } },
                { createdAt: new Date(after[0] as number), id: { lt: after[1] as string } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      include: { batch: { select: { periodStart: true, periodEnd: true } } },
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      next: await this.nextPayout(partnerId),
      items: items.map((p) => this.payoutView(p)),
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }

  private payoutView(p: {
    id: string;
    amount: bigint;
    cashDeduction: bigint;
    status: string;
    utr: string | null;
    failureReason: string | null;
    paidAt: Date | null;
    createdAt: Date;
    batch: { periodStart: Date; periodEnd: Date };
  }) {
    return {
      id: p.id,
      periodStart: p.batch.periodStart,
      periodEnd: p.batch.periodEnd,
      amount: Number(p.amount),
      cashDeduction: Number(p.cashDeduction),
      status: p.status,
      utr: p.utr,
      failureReason: p.failureReason,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
    };
  }

  /** API-EARN-008. */
  async payout(userId: string, payoutId: string) {
    const partnerId = await this.partnerId(userId);
    const p = await this.prisma.payout.findFirst({
      where: { id: payoutId, partnerId },
      include: {
        batch: { select: { periodStart: true, periodEnd: true } },
        partnerBankAccount: { select: { accountLast4: true, ifsc: true } },
      },
    });
    if (!p) throw new AppError('NOT_FOUND', { message: 'Payout not found.' });
    return {
      ...this.payoutView(p),
      bank: p.partnerBankAccount
        ? {
            accountMasked: `XXXXXX${p.partnerBankAccount.accountLast4}`,
            ifsc: p.partnerBankAccount.ifsc,
          }
        : null,
    };
  }

  /** API-EARN-009 (FR-EARN-007): last-30-day rates, computed from the source rows. */
  async performance(userId: string) {
    const partnerId = await this.partnerId(userId);
    const since = new Date(this.clock.now().getTime() - 30 * DAY);
    const [offers, accepted, finished, delivered] = await Promise.all([
      this.prisma.deliveryAssignment.count({
        where: {
          partnerId,
          offeredAt: { gte: since },
          status: { in: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'RELEASED'] },
        },
      }),
      this.prisma.deliveryAssignment.count({
        where: { partnerId, offeredAt: { gte: since }, status: { in: ['ACCEPTED', 'RELEASED'] } },
      }),
      // Trips the partner took on that ended (delivered, or given back / failed on them).
      this.prisma.deliveryAssignment.count({
        where: {
          partnerId,
          offeredAt: { gte: since },
          OR: [
            { status: 'RELEASED' },
            { status: 'ACCEPTED', delivery: { status: { in: ['DELIVERED', 'FAILED'] } } },
          ],
        },
      }),
      this.prisma.delivery.findMany({
        where: { partnerId, status: 'DELIVERED', deliveredAt: { gte: since } },
        select: { deliveredAt: true, order: { select: { etaMaxAt: true } } },
      }),
    ]);
    const late = delivered.filter(
      (d) => d.order.etaMaxAt && d.deliveredAt && d.deliveredAt > d.order.etaMaxAt,
    ).length;
    const rate = (n: number, of: number) => (of === 0 ? null : Math.round((n / of) * 1000) / 10);
    const stats = await this.prisma.partnerStats.findUnique({ where: { partnerId } });
    return {
      windowDays: 30,
      offers,
      acceptanceRate: rate(accepted, offers),
      deliveries: delivered.length,
      completionRate: rate(delivered.length, finished),
      onTimeRate: rate(delivered.length - late, delivered.length),
      rating: stats?.ratingAvgBps ? stats.ratingAvgBps / 100 : null,
      ratingCount: stats?.ratingCount ?? 0,
    };
  }

  /** API-EARN-010 (BR-REVIEW-006): averages and tag counts only. */
  async ratings(userId: string) {
    return this.reviews.partnerSummary(await this.partnerId(userId));
  }

  /** API-EARN-011: masked bank details, plus a pending change if there is one. */
  async bankAccount(userId: string) {
    const partnerId = await this.partnerId(userId);
    const accounts = await this.prisma.partnerBankAccount.findMany({
      where: { partnerId, status: { in: ['VERIFIED', 'PENDING_VERIFICATION'] } },
      orderBy: { createdAt: 'desc' },
    });
    const view = (b: (typeof accounts)[number] | undefined) =>
      b
        ? {
            id: b.id,
            holderName: b.holderName,
            accountMasked: `XXXXXX${b.accountLast4}`,
            ifsc: b.ifsc,
            status: b.status,
            verifiedAt: b.verifiedAt,
          }
        : null;
    const current = accounts.find((b) => b.status === 'VERIFIED') ?? accounts.at(-1);
    const pending = accounts.find((b) => b.status === 'PENDING_VERIFICATION' && b !== current);
    return {
      current: view(current),
      pendingChange: view(pending),
      payoutsOnHold: accounts.some((b) => b.status === 'PENDING_VERIFICATION'),
    };
  }

  /**
   * API-EARN-012 (FR-EARN-006): the new account waits for verification and payouts are
   * held until then; the verified account stays on file meanwhile. The caller has re-authenticated.
   */
  async requestBankChange(
    userId: string,
    input: { holderName: string; accountNumber: string; ifsc: string },
    sessionId: string,
  ) {
    const partnerId = await this.partnerId(userId);
    await this.prisma.$transaction(async (tx) => {
      const verified = await tx.partnerBankAccount.findFirst({
        where: { partnerId, status: 'VERIFIED' },
      });
      // A newer request replaces an older one still waiting.
      await tx.partnerBankAccount.updateMany({
        where: { partnerId, status: 'PENDING_VERIFICATION' },
        data: { status: 'SUPERSEDED' },
      });
      const created = await tx.partnerBankAccount.create({
        data: {
          partnerId,
          holderName: input.holderName,
          accountNumberEncrypted: this.cipher.encrypt(input.accountNumber),
          accountLast4: input.accountNumber.slice(-4),
          ifsc: input.ifsc,
          createdAt: this.clock.now(),
        },
      });
      await this.audit.record(
        {
          action: 'partner.bank_change_requested',
          targetType: 'delivery_partner',
          targetId: partnerId,
          actorUserId: userId,
          sessionId,
          ...(verified
            ? { before: { accountLast4: verified.accountLast4, ifsc: verified.ifsc } }
            : {}),
          after: {
            bankAccountId: created.id,
            accountLast4: created.accountLast4,
            ifsc: created.ifsc,
          },
        },
        tx,
      );
    });
    return this.bankAccount(userId);
  }
}
