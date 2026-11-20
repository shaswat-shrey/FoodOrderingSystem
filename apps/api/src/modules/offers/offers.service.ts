import type { Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { CouponIssue, OfferContext, OfferResolver } from '../checkout';
import type { CouponInput, PromotionInput } from '../pricing';

const couponInclude = {
  restaurants: true,
  zones: true,
  users: true,
} satisfies Prisma.CouponInclude;
type CouponRow = Prisma.CouponGetPayload<{ include: typeof couponInclude }>;
type Db = PrismaClient | Prisma.TransactionClient;

const LIVE_REDEMPTIONS = ['RESERVED', 'REDEEMED'] as const; // BR-COUPON-003

const rupees = (paise: number) => `₹${(paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)}`;

/** Promotions, coupon eligibility (BR-COUPON-001…008) and the redemption lifecycle (FR-COUP-004). */
export class OffersService implements OfferResolver {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  /** Active automatic promotions for the branch (BR-COUPON-005: the engine picks the best). */
  async promotions(ctx: OfferContext): Promise<PromotionInput[]> {
    const now = this.clock.now();
    const rows = await this.prisma.promotion.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
        OR: [{ scope: 'PLATFORM' }, { scope: 'RESTAURANT', restaurantId: ctx.branch.restaurantId }],
      },
      include: { branches: true, items: true },
    });
    const newCustomer = rows.some((p) => p.newCustomersOnly)
      ? await this.isNewCustomer(ctx.userId)
      : false;
    return rows
      .filter(
        (p) => p.branches.length === 0 || p.branches.some((b) => b.branchId === ctx.branch.id),
      )
      .filter((p) => !p.newCustomersOnly || newCustomer)
      .map((p) => ({
        id: p.id,
        title: p.title,
        type: p.type,
        value: p.value,
        maxDiscountAmount: p.maxDiscountAmount,
        minSubtotalAmount: p.minSubtotalAmount,
        foodItemIds: p.items.map((i) => i.foodItemId),
        funding: p.funding,
      }));
  }

  /** BR-COUPON-007: no delivered orders and no live new-user redemption. */
  private async isNewCustomer(userId: string): Promise<boolean> {
    const [delivered, used] = await Promise.all([
      this.prisma.order.count({ where: { userId, status: 'DELIVERED' } }),
      this.prisma.couponRedemption.count({
        where: {
          userId,
          status: { in: [...LIVE_REDEMPTIONS] },
          coupon: { userSegment: 'NEW_USERS' },
        },
      }),
    ]);
    return delivered === 0 && used === 0;
  }

  private async couponById(id: string) {
    return this.prisma.coupon.findFirst({ where: { id, deletedAt: null }, include: couponInclude });
  }

  async couponByCode(code: string) {
    return this.prisma.coupon.findFirst({
      where: { code: code.trim(), deletedAt: null },
      include: couponInclude,
    });
  }

  /**
   * Everything in BR-COUPON-002 except the minimum spend, which the pricing
   * engine checks after the promotion (it knows that amount).
   */
  async eligibility(
    coupon: CouponRow,
    ctx: Omit<OfferContext, 'itemsSubtotal' | 'foodItemIds' | 'userId'> & { userId: string | null },
  ): Promise<CouponIssue | null> {
    const now = this.clock.now();
    if (coupon.status !== 'ACTIVE' || now < coupon.startsAt)
      return { code: 'COUPON_INVALID', message: `${coupon.code} isn't active.` };
    if (now >= coupon.endsAt)
      return { code: 'COUPON_EXPIRED', message: `${coupon.code} has expired.` };
    if (coupon.zones.length > 0 && !coupon.zones.some((z) => z.zoneId === ctx.branch.zoneId)) {
      return { code: 'COUPON_NOT_APPLICABLE', message: `${coupon.code} isn't valid in this area.` };
    }
    if (
      coupon.restaurants.length > 0 &&
      !coupon.restaurants.some((r) => r.restaurantId === ctx.branch.restaurantId)
    ) {
      return {
        code: 'COUPON_NOT_APPLICABLE',
        message: `${coupon.code} isn't valid at ${ctx.branch.restaurant.brandName}.`,
      };
    }
    if (
      ctx.paymentMethod &&
      coupon.paymentMethodRestriction &&
      coupon.paymentMethodRestriction !== ctx.paymentMethod
    ) {
      return {
        code: 'COUPON_NOT_APPLICABLE',
        message: `${coupon.code} needs ${coupon.paymentMethodRestriction === 'ONLINE' ? 'online payment' : coupon.paymentMethodRestriction.toLowerCase()}.`,
      };
    }
    if (
      coupon.usageLimitTotal !== null &&
      coupon.usedCount + coupon.reservedCount >= coupon.usageLimitTotal
    ) {
      return { code: 'COUPON_LIMIT_REACHED', message: `${coupon.code} has been fully used.` };
    }
    if (!ctx.userId) return null; // segment and per-user limits need a signed-in customer
    if (coupon.userSegment === 'TARGETED' && !coupon.users.some((u) => u.userId === ctx.userId)) {
      return {
        code: 'COUPON_NOT_APPLICABLE',
        message: `${coupon.code} isn't available on your account.`,
      };
    }
    if (coupon.userSegment === 'NEW_USERS' && !(await this.isNewCustomer(ctx.userId))) {
      return { code: 'COUPON_NOT_APPLICABLE', message: `${coupon.code} is for your first order.` };
    }
    const mine = await this.prisma.couponRedemption.count({
      where: { couponId: coupon.id, userId: ctx.userId, status: { in: [...LIVE_REDEMPTIONS] } },
    });
    if (mine >= coupon.usageLimitPerUser)
      return { code: 'COUPON_LIMIT_REACHED', message: `You've already used ${coupon.code}.` };
    return null;
  }

  static toInput(c: CouponRow): CouponInput {
    return {
      id: c.id,
      code: c.code,
      type: c.discountType,
      value: c.value,
      maxDiscountAmount: c.maxDiscountAmount,
      funding: c.funding,
      restaurantShareBps: c.restaurantShareBps,
      stackableWithPromotion: c.stackableWithPromotion,
      minSubtotalAmount: c.minSubtotalAmount,
    };
  }

  /** OfferResolver: the cart's coupon, or the reason it can't apply now. */
  async coupon(
    couponId: string,
    ctx: OfferContext,
  ): Promise<{ coupon: CouponInput | null; issue: CouponIssue | null }> {
    const row = await this.couponById(couponId);
    if (!row)
      return {
        coupon: null,
        issue: { code: 'COUPON_INVALID', message: 'This coupon is no longer available.' },
      };
    const issue = await this.eligibility(row, ctx);
    return issue ? { coupon: null, issue } : { coupon: OffersService.toInput(row), issue: null };
  }

  /** API-COUP-002 / FR-COUP-003 */
  async terms(code: string, userId: string | null) {
    const c = await this.couponByCode(code);
    if (
      !c ||
      (c.visibility !== 'PUBLIC' && !(userId && c.users.some((u) => u.userId === userId)))
    ) {
      throw new AppError('COUPON_INVALID');
    }
    const restaurants = c.restaurants.length
      ? (
          await this.prisma.restaurant.findMany({
            where: { id: { in: c.restaurants.map((r) => r.restaurantId) } },
            select: { brandName: true },
          })
        ).map((r) => r.brandName)
      : null;
    const usedByMe = userId
      ? await this.prisma.couponRedemption.count({
          where: { couponId: c.id, userId, status: { in: [...LIVE_REDEMPTIONS] } },
        })
      : null;
    return {
      code: c.code,
      description: c.description,
      discountType: c.discountType,
      value: c.value,
      maxDiscountAmount: c.maxDiscountAmount,
      minSubtotalAmount: c.minSubtotalAmount,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      paymentMethod: c.paymentMethodRestriction,
      newUsersOnly: c.userSegment === 'NEW_USERS',
      usageLimitPerUser: c.usageLimitPerUser,
      remainingForYou: usedByMe === null ? null : Math.max(0, c.usageLimitPerUser - usedByMe),
      restaurants, // null = every restaurant
    };
  }

  /** API-COUP-001 / FR-COUP-001: public and targeted coupons, eligible first, others with a reason. */
  async list(ctx: Omit<OfferContext, 'foodItemIds' | 'userId'> & { userId: string | null }) {
    const now = this.clock.now();
    const rows = await this.prisma.coupon.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        startsAt: { lte: now },
        endsAt: { gt: now },
        OR: [
          { visibility: 'PUBLIC' },
          ...(ctx.userId ? [{ users: { some: { userId: ctx.userId } } }] : []),
        ],
      },
      include: couponInclude,
      orderBy: [{ minSubtotalAmount: 'asc' }, { code: 'asc' }],
    });
    const results = await Promise.all(
      rows.map(async (c) => {
        let issue = await this.eligibility(c, ctx);
        if (!issue && ctx.itemsSubtotal < c.minSubtotalAmount) {
          issue = {
            code: 'COUPON_NOT_APPLICABLE',
            message: `Add ${rupees(c.minSubtotalAmount - ctx.itemsSubtotal)} more to use ${c.code}.`,
          };
        }
        return {
          code: c.code,
          description: c.description,
          discountType: c.discountType,
          eligible: !issue,
          reason: issue?.message ?? null,
        };
      }),
    );
    return results.sort((a, b) => Number(b.eligible) - Number(a.eligible));
  }

  /* ----------------- Redemption lifecycle (FR-COUP-004, BR-COUPON-006) ----------------- */

  /**
   * Reserves one use inside the order-creation transaction. The coupon row is
   * locked so concurrent orders can't exceed its limits.
   */
  async reserve(
    tx: Prisma.TransactionClient,
    input: { couponId: string; userId: string; orderId: string; discountAmount: number },
  ): Promise<void> {
    const [locked] = await tx.$queryRaw<
      {
        usage_limit_total: number | null;
        used_count: number;
        reserved_count: number;
        usage_limit_per_user: number;
        ends_at: Date;
      }[]
    >`
      SELECT usage_limit_total, used_count, reserved_count, usage_limit_per_user, ends_at
      FROM coupons WHERE id = ${input.couponId}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (!locked) throw new AppError('COUPON_INVALID');
    if (this.clock.now() >= locked.ends_at) throw new AppError('COUPON_EXPIRED'); // BR-COUPON-008
    if (
      locked.usage_limit_total !== null &&
      locked.used_count + locked.reserved_count >= locked.usage_limit_total
    ) {
      throw new AppError('COUPON_LIMIT_REACHED');
    }
    const mine = await tx.couponRedemption.count({
      where: {
        couponId: input.couponId,
        userId: input.userId,
        status: { in: [...LIVE_REDEMPTIONS] },
      },
    });
    if (mine >= locked.usage_limit_per_user)
      throw new AppError('COUPON_LIMIT_REACHED', { message: "You've already used this coupon." });
    await tx.couponRedemption.create({ data: { ...input, status: 'RESERVED' } });
    await tx.coupon.update({
      where: { id: input.couponId },
      data: { reservedCount: { increment: 1 } },
    });
  }

  /** RESERVED → REDEEMED on payment success / COD placement. Idempotent. */
  async redeem(db: Db, orderId: string): Promise<boolean> {
    return this.transition(db, orderId, 'REDEEMED');
  }

  /**
   * BR-COUPON-006: the coupon becomes usable again. Works from RESERVED (unpaid
   * order) and from REDEEMED (COD or paid order cancelled where policy restores it).
   */
  async release(db: Db, orderId: string): Promise<boolean> {
    const moved = await db.$queryRaw<{ coupon_id: string; was: string }[]>`
      UPDATE coupon_redemptions r SET status = 'RELEASED', updated_at = now()
      FROM (SELECT order_id, status AS was FROM coupon_redemptions WHERE order_id = ${orderId}::uuid FOR UPDATE) prev
      WHERE r.order_id = prev.order_id AND r.status IN ('RESERVED', 'REDEEMED')
      RETURNING r.coupon_id, prev.was::text AS was`;
    const row = moved[0];
    if (!row) return false;
    await db.$executeRaw`
      UPDATE coupons SET
        reserved_count = reserved_count - ${row.was === 'RESERVED' ? 1 : 0},
        used_count = used_count - ${row.was === 'REDEEMED' ? 1 : 0}, updated_at = now()
      WHERE id = ${row.coupon_id}::uuid`;
    return true;
  }

  private async transition(db: Db, orderId: string, to: 'REDEEMED'): Promise<boolean> {
    const moved = await db.$queryRaw<{ coupon_id: string }[]>`
      UPDATE coupon_redemptions SET status = ${to}::"RedemptionStatus", updated_at = now()
      WHERE order_id = ${orderId}::uuid AND status = 'RESERVED'
      RETURNING coupon_id`;
    const row = moved[0];
    if (!row) return false;
    await db.$executeRaw`
      UPDATE coupons SET reserved_count = reserved_count - 1, used_count = used_count + 1, updated_at = now()
      WHERE id = ${row.coupon_id}::uuid`;
    return true;
  }
}
