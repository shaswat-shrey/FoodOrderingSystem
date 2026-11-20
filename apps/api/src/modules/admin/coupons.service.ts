import type {
  CouponStatus,
  CouponVisibility,
  DiscountFunding,
  DiscountType,
  PaymentMethod,
  Prisma,
  PrismaClient,
  UserSegment,
} from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { AuditService } from '../audit';
import { COUPON_TERM_FIELDS, couponTermIssues } from '../offers';
import { auditAs, maskPhone, pageArgs, pageMeta, type AdminActor, type Page } from './admin.http';

type Tx = Prisma.TransactionClient;

export interface CouponInput {
  code: string;
  description: string;
  discountType: DiscountType;
  value: number;
  maxDiscountAmount?: number | null | undefined;
  minSubtotalAmount: number;
  startsAt?: Date | undefined;
  endsAt: Date;
  usageLimitTotal?: number | null | undefined;
  usageLimitPerUser: number;
  userSegment: UserSegment;
  userIds?: string[] | undefined;
  paymentMethodRestriction?: PaymentMethod | null | undefined;
  funding: DiscountFunding;
  restaurantShareBps?: number | undefined;
  restaurantIds?: string[] | undefined;
  zoneIds?: string[] | undefined;
  stackableWithPromotion: boolean;
  visibility: CouponVisibility;
  status: 'DRAFT' | 'ACTIVE';
  reason: string;
}

export type CouponPatch = Partial<
  Omit<CouponInput, 'code' | 'status' | 'reason'> & { status: 'DRAFT' | 'ACTIVE' }
> & { reason: string };

const include = {
  restaurants: { select: { restaurantId: true } },
  zones: { select: { zoneId: true } },
  users: { select: { userId: true } },
} satisfies Prisma.CouponInclude;
type Row = Prisma.CouponGetPayload<{ include: typeof include }>;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Coupons (FR-ADMIN-060, API-ADM-100…105): the checkout's own rules, admin-managed. */
export class AdminCouponsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private view(c: Row) {
    return {
      id: c.id,
      code: c.code,
      description: c.description,
      discountType: c.discountType,
      value: c.value,
      maxDiscountAmount: c.maxDiscountAmount,
      minSubtotalAmount: c.minSubtotalAmount,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      usageLimitTotal: c.usageLimitTotal,
      usageLimitPerUser: c.usageLimitPerUser,
      usedCount: c.usedCount,
      reservedCount: c.reservedCount,
      userSegment: c.userSegment,
      userIds: c.users.map((u) => u.userId),
      paymentMethodRestriction: c.paymentMethodRestriction,
      funding: c.funding,
      restaurantShareBps: c.restaurantShareBps,
      restaurantIds: c.restaurants.map((r) => r.restaurantId),
      zoneIds: c.zones.map((z) => z.zoneId),
      stackableWithPromotion: c.stackableWithPromotion,
      visibility: c.visibility,
      status: c.status,
      version: c.version,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  /** API-ADM-100 */
  async list(filter: Page & { status?: CouponStatus | undefined; q?: string | undefined }) {
    const where: Prisma.CouponWhereInput = {
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.q
        ? {
            OR: [
              { code: { contains: filter.q, mode: 'insensitive' } },
              { description: { contains: filter.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.coupon.findMany({
        where,
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(filter),
      }),
      this.prisma.coupon.count({ where }),
    ]);
    return { items: rows.map((c) => this.view(c)), meta: pageMeta(filter, total) };
  }

  private async row(db: Tx | PrismaClient, id: string) {
    const c = await db.coupon.findFirst({ where: { id, deletedAt: null }, include });
    if (!c) throw new AppError('NOT_FOUND', { message: "We couldn't find that coupon." });
    return c;
  }

  /** API-ADM-102: the coupon with redemption stats. */
  async detail(id: string) {
    const c = await this.row(this.prisma, id);
    const byStatus = await this.prisma.couponRedemption.groupBy({
      by: ['status'],
      where: { couponId: id },
      _count: { _all: true },
      _sum: { discountAmount: true },
    });
    const stat = (s: string) => byStatus.find((b) => b.status === s);
    return {
      ...this.view(c),
      stats: {
        reserved: stat('RESERVED')?._count._all ?? 0,
        redeemed: stat('REDEEMED')?._count._all ?? 0,
        released: stat('RELEASED')?._count._all ?? 0,
        discountGiven: stat('REDEEMED')?._sum.discountAmount ?? 0,
      },
    };
  }

  /** Scope ids must name real, live rows; targeted customers must be customers. */
  private async checkScope(
    tx: Tx,
    scope: { restaurantIds?: string[]; zoneIds?: string[]; userIds?: string[] },
  ) {
    const bad: { path: string; code: string; message: string }[] = [];
    const count = async (ids: string[] | undefined, n: (ids: string[]) => Promise<number>) =>
      ids && ids.length > 0 && (await n(ids)) !== ids.length;
    if (
      await count(scope.restaurantIds, (ids) =>
        tx.restaurant.count({ where: { id: { in: ids }, onboardingStatus: 'APPROVED' } }),
      )
    )
      bad.push({ path: 'restaurantIds', code: 'UNKNOWN', message: 'Unknown restaurant.' });
    if (
      await count(scope.zoneIds, (ids) =>
        tx.zone.count({ where: { id: { in: ids }, deletedAt: null } }),
      )
    )
      bad.push({ path: 'zoneIds', code: 'UNKNOWN', message: 'Unknown zone.' });
    if (
      await count(scope.userIds, (ids) =>
        tx.user.count({
          where: { id: { in: ids }, status: { in: ['ACTIVE', 'PENDING_VERIFICATION'] } },
        }),
      )
    )
      bad.push({ path: 'userIds', code: 'UNKNOWN', message: 'Unknown customer.' });
    if (bad.length) throw new AppError('VALIDATION_ERROR', { details: bad });
  }

  private validate(terms: Parameters<typeof couponTermIssues>[0]) {
    const issues = couponTermIssues(terms);
    if (issues.length) throw new AppError('VALIDATION_ERROR', { details: issues });
  }

  /** API-ADM-101 ★ */
  async create(actor: AdminActor, input: CouponInput) {
    const now = this.clock.now();
    const startsAt = input.startsAt ?? now;
    const ids = {
      restaurantIds: [...new Set(input.restaurantIds ?? [])],
      zoneIds: [...new Set(input.zoneIds ?? [])],
      userIds: [...new Set(input.userIds ?? [])],
    };
    const funding = input.funding;
    const restaurantShareBps =
      input.restaurantShareBps ??
      (funding === 'RESTAURANT' ? 10_000 : funding === 'SHARED' ? 5_000 : 0);
    this.validate({
      ...input,
      maxDiscountAmount: input.maxDiscountAmount ?? null,
      usageLimitTotal: input.usageLimitTotal ?? null,
      startsAt,
      restaurantShareBps,
      restaurantCount: ids.restaurantIds.length,
      userCount: ids.userIds.length,
    });
    if (input.endsAt.getTime() <= now.getTime())
      throw new AppError('VALIDATION_ERROR', {
        details: [{ path: 'endsAt', code: 'PAST', message: 'The coupon must end in the future.' }],
      });
    const id = await this.prisma.$transaction(async (tx) => {
      if (await tx.coupon.findFirst({ where: { code: input.code, deletedAt: null } }))
        throw new AppError('RESOURCE_CONFLICT', {
          message: `The code ${input.code} is already in use.`,
        });
      await this.checkScope(tx, ids);
      const c = await tx.coupon.create({
        data: {
          code: input.code,
          description: input.description,
          discountType: input.discountType,
          value: input.value,
          maxDiscountAmount: input.maxDiscountAmount ?? null,
          minSubtotalAmount: input.minSubtotalAmount,
          startsAt,
          endsAt: input.endsAt,
          usageLimitTotal: input.usageLimitTotal ?? null,
          usageLimitPerUser: input.usageLimitPerUser,
          userSegment: input.userSegment,
          paymentMethodRestriction: input.paymentMethodRestriction ?? null,
          funding,
          restaurantShareBps,
          stackableWithPromotion: input.stackableWithPromotion,
          visibility: input.visibility,
          status: input.status,
          createdBy: actor.userId,
          restaurants: { create: ids.restaurantIds.map((restaurantId) => ({ restaurantId })) },
          zones: { create: ids.zoneIds.map((zoneId) => ({ zoneId })) },
          users: { create: ids.userIds.map((userId) => ({ userId })) },
        },
        include,
      });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.coupon_created',
          targetType: 'coupon',
          targetId: c.id,
          reason: input.reason,
          after: this.view(c),
          sensitivity: 'HIGH',
        },
        tx,
      );
      return c.id;
    });
    return this.detail(id);
  }

  /** API-ADM-103 ★: discount terms are locked once the coupon has redemptions (BR-COUPON-009). */
  async update(actor: AdminActor, id: string, patch: CouponPatch) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${id}::uuid FOR UPDATE`;
      const c = await this.row(tx, id);
      const before = this.view(c);
      const changedTerms = COUPON_TERM_FIELDS.filter((f) => {
        const next = patch[f];
        if (next === undefined) return false;
        const current = before[f];
        return Array.isArray(next) && Array.isArray(current)
          ? !sameSet(next, current)
          : next !== current;
      });
      if (changedTerms.length > 0 && (await tx.couponRedemption.count({ where: { couponId: id } })))
        throw new AppError('RESOURCE_CONFLICT', {
          message:
            'This coupon has been used, so its discount terms are locked. Create a new coupon instead.',
          details: changedTerms.map((path) => ({ path, code: 'LOCKED', message: 'Locked.' })),
        });
      if (patch.status && c.status === 'INACTIVE')
        throw new AppError('RESOURCE_CONFLICT', {
          message: 'A deactivated coupon stays deactivated. Create a new coupon instead.',
        });
      const next = {
        ...before,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      } as typeof before;
      const ids = {
        restaurantIds: [...new Set(next.restaurantIds)],
        zoneIds: [...new Set(next.zoneIds)],
        userIds: [...new Set(next.userIds)],
      };
      this.validate({
        ...next,
        restaurantCount: ids.restaurantIds.length,
        userCount: ids.userIds.length,
      });
      if (patch.endsAt && patch.endsAt.getTime() <= this.clock.now().getTime())
        throw new AppError('VALIDATION_ERROR', {
          details: [
            { path: 'endsAt', code: 'PAST', message: 'The coupon must end in the future.' },
          ],
        });
      if (next.usageLimitTotal !== null && next.usageLimitTotal < c.usedCount + c.reservedCount)
        throw new AppError('VALIDATION_ERROR', {
          details: [
            {
              path: 'usageLimitTotal',
              code: 'BELOW_USAGE',
              message: `This coupon has already been used ${c.usedCount + c.reservedCount} times.`,
            },
          ],
        });
      await this.checkScope(tx, {
        ...(patch.restaurantIds ? { restaurantIds: ids.restaurantIds } : {}),
        ...(patch.zoneIds ? { zoneIds: ids.zoneIds } : {}),
        ...(patch.userIds ? { userIds: ids.userIds } : {}),
      });
      const replace = <T>(given: unknown, rows: T[]) =>
        given ? { deleteMany: {}, create: rows } : undefined;
      const updated = await tx.coupon.update({
        where: { id },
        data: {
          description: next.description,
          discountType: next.discountType,
          value: next.value,
          maxDiscountAmount: next.maxDiscountAmount,
          minSubtotalAmount: next.minSubtotalAmount,
          startsAt: next.startsAt,
          endsAt: next.endsAt,
          usageLimitTotal: next.usageLimitTotal,
          usageLimitPerUser: next.usageLimitPerUser,
          userSegment: next.userSegment,
          paymentMethodRestriction: next.paymentMethodRestriction,
          funding: next.funding,
          restaurantShareBps: next.restaurantShareBps,
          stackableWithPromotion: next.stackableWithPromotion,
          visibility: next.visibility,
          status: next.status,
          version: { increment: 1 },
          restaurants: replace(
            patch.restaurantIds,
            ids.restaurantIds.map((restaurantId) => ({ restaurantId })),
          ),
          zones: replace(
            patch.zoneIds,
            ids.zoneIds.map((zoneId) => ({ zoneId })),
          ),
          users: replace(
            patch.userIds,
            ids.userIds.map((userId) => ({ userId })),
          ),
        },
        include,
      });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.coupon_updated',
          targetType: 'coupon',
          targetId: id,
          reason: patch.reason,
          before,
          after: this.view(updated),
          sensitivity: 'HIGH',
        },
        tx,
      );
    });
    return this.detail(id);
  }

  /** API-ADM-104 ★: no new uses; reservations already made finish normally (BR-COUPON-006). */
  async deactivate(actor: AdminActor, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${id}::uuid FOR UPDATE`;
      const c = await this.row(tx, id);
      if (c.status === 'INACTIVE')
        throw new AppError('RESOURCE_CONFLICT', { message: 'This coupon is already deactivated.' });
      await tx.coupon.update({
        where: { id },
        data: { status: 'INACTIVE', version: { increment: 1 } },
      });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.coupon_deactivated',
          targetType: 'coupon',
          targetId: id,
          reason,
          before: { status: c.status },
          after: { status: 'INACTIVE' },
          sensitivity: 'HIGH',
        },
        tx,
      );
    });
    return this.detail(id);
  }

  /** API-ADM-105: newest first, customers masked (FR-ADMIN-010). */
  async redemptions(id: string, page: Page) {
    await this.row(this.prisma, id);
    const where = { couponId: id };
    const [rows, total] = await Promise.all([
      this.prisma.couponRedemption.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(page),
        include: {
          user: { select: { id: true, fullName: true, phone: true } },
          order: { select: { id: true, number: true, status: true } },
        },
      }),
      this.prisma.couponRedemption.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        discountAmount: r.discountAmount,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        customer: { id: r.user.id, fullName: r.user.fullName, phone: maskPhone(r.user.phone) },
        order: r.order,
      })),
      meta: pageMeta(page, total),
    };
  }
}
