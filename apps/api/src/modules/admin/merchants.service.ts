import type {
  AccountStatus,
  BranchStatusEventType,
  ChangeRequestStatus,
  ChangeRequestType,
  OnboardingStatus,
  Prisma,
  PrismaClient,
} from '@fos/db';
import type { Clock } from '../../platform/clock';
import type { FieldCipher } from '../../platform/crypto';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import { writeOutbox } from '../../platform/outbox';
import type { AuditService } from '../audit';
import type { FilesService } from '../files';
import type { OnboardingService, PermissionChanges, RestaurantProfileService } from '../merchant';
import type { PricingConfigService } from '../pricing';
import type { AdminActor, Page } from './admin.http';
import { maskPhone, pageArgs, pageMeta } from './admin.http';

type Tx = Prisma.TransactionClient;

/** Cancels an order on the platform's behalf (implemented by the orders module). */
export interface OrderCanceller {
  cancel(input: {
    orderId: string;
    actor: { type: 'ADMIN'; id: string };
    reasonCode: string;
    note?: string | null;
    fault: 'RESTAURANT';
  }): Promise<unknown>;
}

/** Orders a restaurant suspension may cancel: not yet with a rider (FR-ADMIN-023). */
const CANCELLABLE = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] as const;

export interface RestaurantPatch {
  brandName?: string | undefined;
  description?: string | null | undefined;
  contactEmail?: string | undefined;
  contactPhone?: string | undefined;
  pureVeg?: boolean | undefined;
  cuisineIds?: string[] | undefined;
}

/**
 * Restaurant applications, restaurants, branches and their change requests for
 * the admin console (FR-ADMIN-020…023, FR-ADMIN-072, API-ADM-020…038, 040).
 */
export class AdminMerchantsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly onboarding: OnboardingService,
    private readonly profiles: RestaurantProfileService,
    private readonly pricing: PricingConfigService,
    private readonly permissionChanges: PermissionChanges,
    private readonly orders: OrderCanceller,
    private readonly files: FilesService,
    private readonly cipher: FieldCipher,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  private record(
    actor: AdminActor,
    entry: {
      action: string;
      targetType: string;
      targetId: string;
      reason?: string | null;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      sensitivity?: 'NORMAL' | 'HIGH';
    },
    tx?: Tx,
  ) {
    return this.audit.record(
      {
        ...entry,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        sessionId: actor.sessionId,
        reason: entry.reason ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        sensitivity: entry.sensitivity ?? 'HIGH',
      },
      tx,
    );
  }

  private meta(actor: AdminActor) {
    return { sessionId: actor.sessionId, actorRoles: actor.roles };
  }

  /* ---------------- applications (API-ADM-020…025) ---------------- */

  /** API-ADM-020: the review queue, oldest first (default: submitted or under review). */
  async applications(filter: Page & { status?: OnboardingStatus | undefined }) {
    const where: Prisma.RestaurantWhereInput = {
      onboardingStatus: filter.status ?? { in: ['SUBMITTED', 'UNDER_REVIEW'] },
    };
    const [rows, total] = await Promise.all([
      this.prisma.restaurant.findMany({
        where,
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(filter),
        select: {
          id: true,
          brandName: true,
          legalName: true,
          onboardingStatus: true,
          submissionCount: true,
          createdAt: true,
          updatedAt: true,
          branches: { select: { city: true, area: true }, take: 1 },
          members: {
            where: { role: 'OWNER' },
            select: { user: { select: { id: true, fullName: true } } },
            take: 1,
          },
        },
      }),
      this.prisma.restaurant.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        brandName: r.brandName,
        legalName: r.legalName,
        status: r.onboardingStatus,
        submissionCount: r.submissionCount,
        city: r.branches[0]?.city ?? null,
        area: r.branches[0]?.area ?? null,
        owner: r.members[0]?.user ?? null,
        createdAt: r.createdAt,
        waitingSince: r.updatedAt,
      })),
      meta: pageMeta(filter, total),
    };
  }

  application(id: string) {
    return this.onboarding.adminView(id);
  }

  startReview(actor: AdminActor, id: string) {
    return this.onboarding.startReview(actor.userId, id, this.meta(actor));
  }

  async decideApplication(
    actor: AdminActor,
    id: string,
    input: {
      decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
      reason?: string | undefined;
      comments?: Record<string, string> | undefined;
    },
  ) {
    if (!(await this.prisma.restaurant.count({ where: { id } })))
      throw new AppError('NOT_FOUND', { message: "We couldn't find that application." });
    await this.onboarding.decide(
      actor.userId,
      id,
      {
        decision: input.decision,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.comments ? { comments: input.comments } : {}),
      },
      this.meta(actor),
    );
    return this.onboarding.adminView(id);
  }

  /* ---------------- restaurants (API-ADM-026…033, 037, 038) ---------------- */

  /** API-ADM-026: live (approved) restaurants. */
  async restaurants(
    filter: Page & {
      status?: AccountStatus | undefined;
      zone?: string | undefined;
      q?: string | undefined;
    },
  ) {
    const q = filter.q?.trim();
    const where: Prisma.RestaurantWhereInput = {
      onboardingStatus: 'APPROVED',
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.zone ? { branches: { some: { zoneId: filter.zone, deletedAt: null } } } : {}),
      ...(q
        ? {
            OR: [
              { brandName: { contains: q, mode: 'insensitive' } },
              { legalName: { contains: q, mode: 'insensitive' } },
              { fssaiNumber: q },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.restaurant.findMany({
        where,
        orderBy: [{ brandName: 'asc' }, { id: 'asc' }],
        ...pageArgs(filter),
        select: {
          id: true,
          brandName: true,
          status: true,
          codEnabled: true,
          ratingAvgBps: true,
          ratingCount: true,
          approvedAt: true,
          branches: {
            where: { deletedAt: null },
            select: { id: true, name: true, status: true, zoneId: true },
          },
        },
      }),
      this.prisma.restaurant.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        brandName: r.brandName,
        status: r.status,
        codEnabled: r.codEnabled,
        rating: r.ratingCount
          ? { average: (r.ratingAvgBps ?? 0) / 100, count: r.ratingCount }
          : null,
        branches: r.branches,
        approvedAt: r.approvedAt,
      })),
      meta: pageMeta(filter, total),
    };
  }

  private async restaurantRow(db: Tx | PrismaClient, id: string, lock = false) {
    if (lock) await db.$queryRaw`SELECT id FROM restaurants WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await db.restaurant.findUnique({ where: { id } });
    if (!r) throw new AppError('NOT_FOUND', { message: "We couldn't find that restaurant." });
    return r;
  }

  /** API-ADM-027: restaurant 360 (legal numbers masked). */
  async restaurant(id: string) {
    const r = await this.restaurantRow(this.prisma, id);
    const now = this.clock.now();
    const [profile, branches, members, commission, orders, delivered, overrides] =
      await Promise.all([
        this.profiles.view(id),
        this.prisma.branch.findMany({
          where: { restaurantId: id, deletedAt: null },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            area: true,
            city: true,
            status: true,
            isOpenManual: true,
            pausedUntil: true,
            zone: { select: { id: true, name: true } },
          },
        }),
        this.prisma.restaurantMember.findMany({
          where: { restaurantId: id, status: { not: 'REMOVED' } },
          select: {
            role: true,
            status: true,
            user: { select: { id: true, fullName: true, phone: true } },
          },
        }),
        this.pricing.commissionRateBps(id, now).catch(() => null),
        this.prisma.order.count({ where: { restaurantId: id } }),
        this.prisma.order.count({ where: { restaurantId: id, status: 'DELIVERED' } }),
        this.prisma.restaurantCommissionOverride.findMany({
          where: { restaurantId: id, effectiveFrom: { gt: now } },
          orderBy: { effectiveFrom: 'asc' },
          select: { rateBps: true, effectiveFrom: true },
        }),
      ]);
    return {
      ...profile,
      status: r.status,
      onboardingStatus: r.onboardingStatus,
      codEnabled: r.codEnabled,
      approvedAt: r.approvedAt,
      commission: commission
        ? { rateBps: commission.rateBps, source: commission.source, scheduled: overrides }
        : null,
      branches,
      members: members.map((m) => ({
        role: m.role,
        status: m.status,
        user: { id: m.user.id, fullName: m.user.fullName, phone: maskPhone(m.user.phone) },
      })),
      orders: { total: orders, delivered },
    };
  }

  /** Listings and menus show restaurant fields: refresh every branch's caches. */
  private async touchBranches(tx: Tx, restaurantId: string) {
    await tx.branch.updateMany({
      where: { restaurantId },
      data: { menuVersion: { increment: 1 }, version: { increment: 1 } },
    });
  }

  /** API-ADM-028 ★: non-financial details on the owner's behalf. */
  async updateRestaurant(actor: AdminActor, id: string, patch: RestaurantPatch, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.restaurantRow(tx, id, true);
      if (patch.cuisineIds) {
        const ids = [...new Set(patch.cuisineIds)];
        if ((await tx.cuisine.count({ where: { id: { in: ids }, isActive: true } })) !== ids.length)
          throw new AppError('VALIDATION_ERROR', {
            details: [{ path: 'cuisineIds', code: 'INVALID', message: 'Unknown cuisine.' }],
          });
        await tx.restaurantCuisine.deleteMany({ where: { restaurantId: id } });
        await tx.restaurantCuisine.createMany({
          data: ids.map((cuisineId) => ({ restaurantId: id, cuisineId })),
        });
      }
      const fields = [
        'brandName',
        'description',
        'contactEmail',
        'contactPhone',
        'pureVeg',
      ] as const;
      const data: Prisma.RestaurantUpdateInput = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const f of fields) {
        if (patch[f] === undefined) continue;
        before[f] = r[f];
        after[f] = patch[f];
        (data as Record<string, unknown>)[f] = patch[f];
      }
      if (patch.cuisineIds) after.cuisineIds = patch.cuisineIds;
      await tx.restaurant.update({ where: { id }, data });
      await this.touchBranches(tx, id);
      await this.record(
        actor,
        {
          action: 'admin.restaurant_updated',
          targetType: 'restaurant',
          targetId: id,
          reason,
          before,
          after,
        },
        tx,
      );
    });
    return this.restaurant(id);
  }

  private async memberIds(restaurantId: string) {
    const rows = await this.prisma.restaurantMember.findMany({
      where: { restaurantId, status: 'ACTIVE' },
      select: { userId: true },
    });
    return rows.map((m) => m.userId);
  }

  /**
   * API-ADM-029 ★ (FR-ADMIN-023): stops new orders at once (every branch reads
   * as not listed) and drops staff access; in-flight orders continue unless
   * `cancelActive`, which cancels those not yet picked up as a restaurant fault.
   */
  async suspendRestaurant(
    actor: AdminActor,
    id: string,
    input: { reason: string; cancelActive: boolean },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.restaurantRow(tx, id, true);
      if (r.onboardingStatus !== 'APPROVED')
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'Only an approved restaurant can be suspended.',
        });
      if (r.status !== 'ACTIVE') throw new AppError('ACCOUNT_STATE_CONFLICT');
      await tx.restaurant.update({ where: { id }, data: { status: 'SUSPENDED' } });
      await this.touchBranches(tx, id);
      await writeOutbox(tx, {
        aggregateType: 'restaurant',
        aggregateId: id,
        aggregateVersion: 1,
        eventType: 'restaurant.suspended',
        payload: { restaurantId: id, cancelActive: input.cancelActive },
      });
      await this.record(
        actor,
        {
          action: 'admin.restaurant_suspended',
          targetType: 'restaurant',
          targetId: id,
          reason: input.reason,
          before: { status: r.status },
          after: { status: 'SUSPENDED', cancelActive: input.cancelActive },
        },
        tx,
      );
    });
    // IAM grants restaurant permissions only while the restaurant is ACTIVE.
    for (const userId of await this.memberIds(id)) await this.permissionChanges.changed(userId);
    let cancelled = 0;
    let notCancelled = 0;
    if (input.cancelActive) {
      const active = await this.prisma.order.findMany({
        where: { restaurantId: id, status: { in: [...CANCELLABLE] } },
        select: { id: true },
      });
      for (const o of active) {
        try {
          await this.orders.cancel({
            orderId: o.id,
            actor: { type: 'ADMIN', id: actor.userId },
            reasonCode: 'RESTAURANT_SUSPENDED',
            note: input.reason,
            fault: 'RESTAURANT',
          });
          cancelled++;
        } catch (error) {
          notCancelled++;
          this.logger.warn({ err: error, orderId: o.id }, 'suspension cancel skipped');
        }
      }
    }
    return {
      ...(await this.restaurant(id)),
      ...(input.cancelActive
        ? { cancelledOrders: cancelled, notCancelledOrders: notCancelled }
        : {}),
    };
  }

  /** API-ADM-030 ★ */
  async unsuspendRestaurant(actor: AdminActor, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.restaurantRow(tx, id, true);
      if (r.status !== 'SUSPENDED')
        throw new AppError('ACCOUNT_STATE_CONFLICT', {
          message: 'This restaurant isn’t suspended.',
        });
      await tx.restaurant.update({ where: { id }, data: { status: 'ACTIVE' } });
      await this.touchBranches(tx, id);
      await writeOutbox(tx, {
        aggregateType: 'restaurant',
        aggregateId: id,
        aggregateVersion: 1,
        eventType: 'restaurant.unsuspended',
        payload: { restaurantId: id },
      });
      await this.record(
        actor,
        {
          action: 'admin.restaurant_unsuspended',
          targetType: 'restaurant',
          targetId: id,
          reason,
          before: { status: 'SUSPENDED' },
          after: { status: 'ACTIVE' },
        },
        tx,
      );
    });
    for (const userId of await this.memberIds(id)) await this.permissionChanges.changed(userId);
    return this.restaurant(id);
  }

  /**
   * API-ADM-031…033 ★: branch suspend / unsuspend / approve. Status is read by
   * every availability check (computeBranchStatus), so a suspended branch stops
   * taking orders immediately; the status log and menu version are updated too.
   */
  async setBranchStatus(
    actor: AdminActor,
    branchId: string,
    action: 'SUSPEND' | 'UNSUSPEND' | 'APPROVE',
    reason: string,
  ) {
    const rule = {
      SUSPEND: { from: ['ACTIVE'], to: 'SUSPENDED', event: 'SUSPENDED' },
      UNSUSPEND: { from: ['SUSPENDED'], to: 'ACTIVE', event: 'UNSUSPENDED' },
      APPROVE: { from: ['PENDING_APPROVAL'], to: 'ACTIVE', event: null },
    }[action] as {
      from: string[];
      to: 'ACTIVE' | 'SUSPENDED';
      event: BranchStatusEventType | null;
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM branches WHERE id = ${branchId}::uuid FOR UPDATE`;
      const b = await tx.branch.findFirst({
        where: { id: branchId, deletedAt: null },
        include: { restaurant: { select: { onboardingStatus: true } } },
      });
      if (!b) throw new AppError('NOT_FOUND', { message: "We couldn't find that branch." });
      if (!rule.from.includes(b.status))
        throw new AppError('ACCOUNT_STATE_CONFLICT', {
          message: `This branch is ${b.status.toLowerCase().replace('_', ' ')}.`,
        });
      if (action === 'APPROVE' && b.restaurant.onboardingStatus !== 'APPROVED')
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'Approve the restaurant application first.',
        });
      const now = this.clock.now();
      await tx.branch.update({
        where: { id: branchId },
        data: {
          status: rule.to,
          ...(action === 'APPROVE' ? { isOpenManual: false } : {}),
          menuVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (rule.event)
        await tx.branchStatusEvent.create({
          data: { branchId, event: rule.event, actorId: actor.userId, reason, createdAt: now },
        });
      await writeOutbox(tx, {
        aggregateType: 'branch',
        aggregateId: branchId,
        aggregateVersion: b.menuVersion + 1,
        eventType: `branch.${action === 'APPROVE' ? 'approved' : rule.event!.toLowerCase()}`,
        payload: { branchId, restaurantId: b.restaurantId, reason },
      });
      await this.record(
        actor,
        {
          action: `admin.branch_${action.toLowerCase()}${action === 'APPROVE' ? 'd' : 'ed'}`,
          targetType: 'branch',
          targetId: branchId,
          reason,
          before: { status: b.status },
          after: { status: rule.to },
        },
        tx,
      );
      return { id: branchId, restaurantId: b.restaurantId, status: rule.to };
    });
  }

  /** API-ADM-037 ★ (FR-ADMIN-072): a restaurant's own commission rate from a date (never edited in place). */
  async setCommission(
    actor: AdminActor,
    id: string,
    input: { rateBps: number; effectiveFrom?: Date | undefined; reason: string },
  ) {
    const now = this.clock.now();
    const effectiveFrom = input.effectiveFrom ?? now;
    if (effectiveFrom.getTime() < now.getTime() - 60_000)
      throw new AppError('VALIDATION_ERROR', {
        details: [
          { path: 'effectiveFrom', code: 'PAST', message: 'A commission can’t start in the past.' },
        ],
      });
    const before = await this.pricing.commissionRateBps(id, effectiveFrom).catch(() => null);
    await this.prisma.$transaction(async (tx) => {
      await this.restaurantRow(tx, id, true);
      await tx.restaurantCommissionOverride.upsert({
        where: { restaurantId_effectiveFrom: { restaurantId: id, effectiveFrom } },
        create: {
          restaurantId: id,
          rateBps: input.rateBps,
          effectiveFrom,
          createdBy: actor.userId,
        },
        update: { rateBps: input.rateBps, createdBy: actor.userId },
      });
      await this.record(
        actor,
        {
          action: 'admin.restaurant_commission_set',
          targetType: 'restaurant',
          targetId: id,
          reason: input.reason,
          before: before ? { rateBps: before.rateBps, source: before.source } : {},
          after: { rateBps: input.rateBps, effectiveFrom: effectiveFrom.toISOString() },
        },
        tx,
      );
    });
    return { restaurantId: id, rateBps: input.rateBps, effectiveFrom };
  }

  /** API-ADM-038 ★: cash on delivery for the whole restaurant (checked at checkout). */
  async setCod(actor: AdminActor, id: string, input: { enabled: boolean; reason: string }) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.restaurantRow(tx, id, true);
      await tx.restaurant.update({ where: { id }, data: { codEnabled: input.enabled } });
      await this.touchBranches(tx, id);
      await this.record(
        actor,
        {
          action: input.enabled ? 'admin.restaurant_cod_enabled' : 'admin.restaurant_cod_disabled',
          targetType: 'restaurant',
          targetId: id,
          reason: input.reason,
          before: { codEnabled: r.codEnabled },
          after: { codEnabled: input.enabled },
        },
        tx,
      );
    });
    return { restaurantId: id, codEnabled: input.enabled };
  }

  /* ---------------- change requests (API-ADM-034…036) ---------------- */

  private values(payload: Uint8Array) {
    return JSON.parse(this.cipher.decrypt(payload)) as Record<string, string>;
  }

  /** What a reviewer sees of requested values: names and public numbers; PAN and account masked. */
  private preview(type: ChangeRequestType, v: Record<string, string>) {
    switch (type) {
      case 'PAN':
        return { panMasked: `XXXXXX${(v.pan ?? '').slice(-4)}` };
      case 'BANK_ACCOUNT':
        return {
          holderName: v.holderName,
          accountMasked: `XXXXXX${(v.accountNumber ?? '').slice(-4)}`,
          ifsc: v.ifsc,
        };
      default:
        return v;
    }
  }

  /** API-ADM-034: legal, tax and bank change requests (default: pending, oldest first). */
  async changeRequests(
    filter: Page & {
      type?: ChangeRequestType | undefined;
      status?: ChangeRequestStatus | undefined;
    },
  ) {
    const where: Prisma.RestaurantChangeRequestWhereInput = {
      status: filter.status ?? 'PENDING',
      ...(filter.type ? { type: filter.type } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.restaurantChangeRequest.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(filter),
        include: { restaurant: { select: { id: true, brandName: true } } },
      }),
      this.prisma.restaurantChangeRequest.count({ where }),
    ]);
    return {
      items: rows.map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        restaurant: c.restaurant,
        requested: this.preview(c.type, this.values(c.payloadEncrypted)),
        reason: c.reason,
        requestedBy: c.requestedBy,
        createdAt: c.createdAt,
        decidedAt: c.decidedAt,
      })),
      meta: pageMeta(filter, total),
    };
  }

  /** Applies approved values to the restaurant; a new bank account supersedes the old ones. */
  private async apply(
    tx: Tx,
    restaurantId: string,
    type: ChangeRequestType,
    v: Record<string, string>,
  ) {
    switch (type) {
      case 'LEGAL_NAME':
        await tx.restaurant.update({
          where: { id: restaurantId },
          data: { legalName: v.legalName! },
        });
        return;
      case 'PAN':
        await tx.restaurant.update({
          where: { id: restaurantId },
          data: { panEncrypted: this.cipher.encrypt(v.pan!), panLast4: v.pan!.slice(-4) },
        });
        return;
      case 'GSTIN':
        await tx.restaurant.update({ where: { id: restaurantId }, data: { gstin: v.gstin! } });
        return;
      case 'FSSAI':
        await tx.restaurant.update({
          where: { id: restaurantId },
          data: {
            fssaiNumber: v.fssaiNumber!,
            fssaiExpiresOn: new Date(`${v.fssaiExpiresOn!}T00:00:00Z`),
          },
        });
        await this.touchBranches(tx, restaurantId); // the FSSAI expiry gates ordering
        return;
      case 'BANK_ACCOUNT':
        await tx.restaurantBankAccount.updateMany({
          where: { restaurantId, status: { in: ['VERIFIED', 'PENDING_VERIFICATION'] } },
          data: { status: 'SUPERSEDED' },
        });
        await tx.restaurantBankAccount.create({
          data: {
            restaurantId,
            holderName: v.holderName!,
            accountNumberEncrypted: this.cipher.encrypt(v.accountNumber!),
            accountLast4: v.accountNumber!.slice(-4),
            ifsc: v.ifsc!,
            status: 'VERIFIED',
            verifiedAt: this.clock.now(),
          },
        });
        return;
    }
  }

  /** API-ADM-035/036 ★ (FR-ADMIN-022) */
  async decideChange(
    actor: AdminActor,
    id: string,
    input: { decision: 'APPROVED' | 'REJECTED'; reason: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM restaurant_change_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const c = await tx.restaurantChangeRequest.findUnique({ where: { id } });
      if (!c) throw new AppError('NOT_FOUND', { message: "We couldn't find that change request." });
      if (c.status !== 'PENDING')
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'This change request has already been decided.',
        });
      await this.restaurantRow(tx, c.restaurantId, true);
      if (input.decision === 'APPROVED')
        await this.apply(tx, c.restaurantId, c.type, this.values(c.payloadEncrypted));
      const decidedAt = this.clock.now();
      await tx.restaurantChangeRequest.update({
        where: { id },
        data: { status: input.decision, decidedBy: actor.userId, decidedAt, reason: input.reason },
      });
      await writeOutbox(tx, {
        aggregateType: 'restaurant',
        aggregateId: c.restaurantId,
        aggregateVersion: 1,
        eventType: `restaurant.change_${input.decision.toLowerCase()}`,
        payload: { restaurantId: c.restaurantId, changeRequestId: id, type: c.type },
      });
      await this.record(
        actor,
        {
          action: `admin.change_request_${input.decision.toLowerCase()}`,
          targetType: 'restaurant',
          targetId: c.restaurantId,
          reason: input.reason,
          after: { changeRequestId: id, type: c.type, status: input.decision },
        },
        tx,
      );
      return { id, restaurantId: c.restaurantId, type: c.type, status: input.decision, decidedAt };
    });
  }

  /* ---------------- documents (API-ADM-040) ---------------- */

  /** API-ADM-040 (FR-FILE-004): a 5-minute URL for a restaurant or partner verification document. */
  async documentUrl(actor: AdminActor, documentId: string) {
    const [restaurantDoc, partnerDoc] = await Promise.all([
      this.prisma.restaurantDocument.findUnique({
        where: { id: documentId },
        select: { fileId: true, type: true, restaurantId: true },
      }),
      this.prisma.partnerDocument.findUnique({
        where: { id: documentId },
        select: { fileId: true, type: true, partnerId: true },
      }),
    ]);
    const doc = restaurantDoc
      ? { fileId: restaurantDoc.fileId, type: 'restaurant_document', kind: restaurantDoc.type }
      : partnerDoc
        ? { fileId: partnerDoc.fileId, type: 'partner_document', kind: partnerDoc.type }
        : null;
    if (!doc) throw new AppError('NOT_FOUND', { message: "We couldn't find that document." });
    const signed = await this.files.signedUrlForStaff(actor, doc.fileId, {
      type: doc.type,
      id: documentId,
    });
    return { documentId, type: doc.kind, ...signed };
  }
}
