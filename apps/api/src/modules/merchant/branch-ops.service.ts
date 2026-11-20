import type { BranchStatusEventType, PackagingFeeMode, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import { writeOutbox } from '../../platform/outbox';
import type { AuditService } from '../audit';
import { localParts, zonedInstant, type BranchRepository } from '../catalog';
import type { SettingsService } from '../config';
import { fromTime, toTime, type Slot } from './hours';

type Tx = Prisma.TransactionClient;

const REASON_TEXT: Record<string, string> = {
  NOT_LISTED: 'Not live — pending approval or deactivated',
  ZONE_SUSPENDED: 'Closed — deliveries are suspended in this area',
  FSSAI_EXPIRED: 'Paused — FSSAI licence has expired',
  PAUSED: 'Paused',
  MANUALLY_CLOSED: 'Closed — switched offline',
  HOLIDAY: 'Closed — holiday',
  OUTSIDE_HOURS: 'Closed — outside operating hours',
  LAST_ORDER_CUTOFF: 'Closed — past last-order time',
};

export interface BranchSettingsPatch {
  name?: string | undefined;
  phone?: string | null | undefined;
  deliveryRadiusM?: number | undefined;
  minOrderAmount?: number | undefined;
  maxOrderAmount?: number | null | undefined;
  priceForTwo?: number | null | undefined;
  packagingFeeMode?: PackagingFeeMode | undefined;
  packagingFeeAmount?: number | undefined;
}

/**
 * Day-to-day branch operations (FR-REST-011…018, API-MER-014…027). Every
 * change bumps `menu_version`, so cached menus and listings refresh, and
 * open/close/pause write the append-only `branch_status_events` log.
 */
export class BranchOpsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly branches: BranchRepository,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  private async lock(tx: Tx, branchId: string) {
    await tx.$queryRaw`SELECT id FROM branches WHERE id = ${branchId}::uuid FOR UPDATE`;
    return tx.branch.findUniqueOrThrow({
      where: { id: branchId },
      include: { zone: { select: { maxDeliveryRadiusM: true } } },
    });
  }

  private async event(
    tx: Tx,
    branchId: string,
    event: BranchStatusEventType,
    actorId: string | null,
    extra: { reason?: string | null; until?: Date | null } = {},
  ) {
    await tx.branchStatusEvent.create({
      data: {
        branchId,
        event,
        actorId,
        reason: extra.reason ?? null,
        until: extra.until ?? null,
        createdAt: this.clock.now(),
      },
    });
    const b = await tx.branch.update({
      where: { id: branchId },
      data: { menuVersion: { increment: 1 }, version: { increment: 1 } },
      select: { menuVersion: true },
    });
    await writeOutbox(tx, {
      aggregateType: 'branch',
      aggregateId: branchId,
      aggregateVersion: b.menuVersion,
      eventType: `branch.${event.toLowerCase()}`,
      payload: {
        branchId,
        reason: extra.reason ?? null,
        until: extra.until?.toISOString() ?? null,
      },
    });
  }

  /** API-MER-027 (FR-REST-018): effective status with a human reason. */
  async status(branchId: string) {
    const b = await this.branches.loadOne(branchId, this.clock.now());
    if (!b) throw new AppError('NOT_FOUND');
    const c = b.computed;
    const fmt = (d: Date | null) => {
      if (!d) return null;
      const m = localParts(d, b.timezone).minutes;
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    const base = c.reason
      ? (REASON_TEXT[c.reason] ?? c.reason)
      : c.state === 'CLOSING_SOON'
        ? 'Open — closing soon'
        : 'Open';
    const label =
      c.reason === 'PAUSED' && b.pausedUntil
        ? `Paused until ${fmt(b.pausedUntil)}${b.pauseReason ? ` (${b.pauseReason})` : ''}`
        : base;
    return {
      state: c.state,
      acceptingOrders: c.acceptingOrders,
      reason: c.reason,
      label,
      opensAt: c.opensAt,
      lastOrderAt: c.lastOrderAt,
      online: b.isOpenManual,
      pausedUntil: b.pausedUntil && b.pausedUntil > this.clock.now() ? b.pausedUntil : null,
      pauseReason: b.pauseReason,
      rush:
        b.rushUntil && b.rushUntil > this.clock.now()
          ? { extraMinutes: b.rushExtraMinutes, until: b.rushUntil }
          : null,
    };
  }

  /** API-MER-016 */
  async settings_(branchId: string) {
    const [b] = await this.prisma.$queryRaw<{ lat: number; lng: number }[]>`
      SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM branches WHERE id = ${branchId}::uuid`;
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: branchId },
      include: {
        zone: { select: { id: true, name: true, maxDeliveryRadiusM: true } },
        operatingHours: { orderBy: [{ weekday: 'asc' }, { opensAt: 'asc' }] },
        holidays: { where: { endsAt: { gt: this.clock.now() } }, orderBy: { startsAt: 'asc' } },
      },
    });
    return {
      id: branch.id,
      restaurantId: branch.restaurantId,
      name: branch.name,
      address: {
        line1: branch.line1,
        line2: branch.line2,
        area: branch.area,
        city: branch.city,
        state: branch.state,
        pincode: branch.pincode,
        location: b ? { lat: Number(b.lat), lng: Number(b.lng) } : null,
      },
      zone: branch.zone,
      phone: branch.phone,
      status: branch.status,
      deliveryRadiusM: branch.deliveryRadiusM,
      minOrderAmount: branch.minOrderAmount,
      maxOrderAmount: branch.maxOrderAmount,
      priceForTwo: branch.priceForTwo,
      packagingFeeMode: branch.packagingFeeMode,
      packagingFeeAmount: branch.packagingFeeAmount,
      defaultPrepMinutes: branch.defaultPrepMinutes,
      hours: branch.operatingHours.map((h) => ({
        weekday: h.weekday,
        opensAt: fromTime(h.opensAt),
        closesAt: fromTime(h.closesAt),
      })),
      holidays: branch.holidays.map((h) => ({
        id: h.id,
        startsAt: h.startsAt,
        endsAt: h.endsAt,
        reason: h.reason,
      })),
      version: branch.version,
    };
  }

  /** API-MER-017 (FR-REST-017, BR-GEO-002, BR-PRICE-006/010/011). */
  async updateSettings(actorId: string, branchId: string, patch: BranchSettingsPatch) {
    await this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, branchId);
      const problems: { path: string; code: string; message: string }[] = [];
      if (
        patch.deliveryRadiusM !== undefined &&
        (patch.deliveryRadiusM < 500 || patch.deliveryRadiusM > b.zone.maxDeliveryRadiusM)
      )
        problems.push({
          path: 'deliveryRadiusM',
          code: 'OUT_OF_RANGE',
          message: `Between 0.5 and ${b.zone.maxDeliveryRadiusM / 1000} km in this area.`,
        });
      const platformMax = await this.settings.get('order.maxOrderAmount');
      if (patch.maxOrderAmount != null && patch.maxOrderAmount > platformMax)
        problems.push({
          path: 'maxOrderAmount',
          code: 'OUT_OF_RANGE',
          message: `At most ₹${platformMax / 100}.`,
        });
      const min = patch.minOrderAmount ?? b.minOrderAmount;
      const max = patch.maxOrderAmount === undefined ? b.maxOrderAmount : patch.maxOrderAmount;
      if (max != null && min > max)
        problems.push({
          path: 'minOrderAmount',
          code: 'OUT_OF_RANGE',
          message: 'Minimum can’t exceed maximum.',
        });
      const mode = patch.packagingFeeMode ?? b.packagingFeeMode;
      const amount = patch.packagingFeeAmount ?? (mode === 'NONE' ? 0 : b.packagingFeeAmount);
      const cap =
        mode === 'PER_ITEM'
          ? await this.settings.get('packaging.maxPerItem')
          : mode === 'PER_ORDER'
            ? await this.settings.get('packaging.maxPerOrder')
            : 0;
      if (amount > cap)
        problems.push({
          path: 'packagingFeeAmount',
          code: 'OUT_OF_RANGE',
          message:
            mode === 'NONE' ? 'Choose a packaging fee type first.' : `At most ₹${cap / 100}.`,
        });
      if (problems.length) throw new AppError('VALIDATION_ERROR', { details: problems });
      const before = {
        deliveryRadiusM: b.deliveryRadiusM,
        minOrderAmount: b.minOrderAmount,
        maxOrderAmount: b.maxOrderAmount,
        packagingFeeMode: b.packagingFeeMode,
        packagingFeeAmount: b.packagingFeeAmount,
      };
      await tx.branch.update({
        where: { id: branchId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
          ...(patch.deliveryRadiusM !== undefined
            ? { deliveryRadiusM: patch.deliveryRadiusM }
            : {}),
          ...(patch.minOrderAmount !== undefined ? { minOrderAmount: patch.minOrderAmount } : {}),
          ...(patch.maxOrderAmount !== undefined ? { maxOrderAmount: patch.maxOrderAmount } : {}),
          ...(patch.priceForTwo !== undefined ? { priceForTwo: patch.priceForTwo } : {}),
          packagingFeeMode: mode,
          packagingFeeAmount: mode === 'NONE' ? 0 : amount,
          menuVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      await this.audit.record(
        {
          action: 'branch.settings_updated',
          targetType: 'branch',
          targetId: branchId,
          actorUserId: actorId,
          before,
          after: { ...patch },
        },
        tx,
      );
    });
    return this.settings_(branchId);
  }

  /** API-MER-018 (FR-REST-012): replace the weekly hours. */
  async replaceHours(actorId: string, branchId: string, hours: Slot[]) {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, branchId);
      await tx.branchOperatingHour.deleteMany({ where: { branchId } });
      await tx.branchOperatingHour.createMany({
        data: hours.map((s) => ({
          branchId,
          weekday: s.weekday,
          opensAt: toTime(s.opensAt),
          closesAt: toTime(s.closesAt),
        })),
      });
      await tx.branch.update({
        where: { id: branchId },
        data: { menuVersion: { increment: 1 }, version: { increment: 1 } },
      });
      await this.audit.record(
        {
          action: 'branch.hours_replaced',
          targetType: 'branch',
          targetId: branchId,
          actorUserId: actorId,
          after: { slots: hours.length },
        },
        tx,
      );
    });
    return this.settings_(branchId);
  }

  /** API-MER-020 (FR-REST-013) */
  async addHoliday(
    actorId: string,
    branchId: string,
    input: { startsAt: Date; endsAt: Date; reason?: string | undefined },
  ) {
    if (input.endsAt <= input.startsAt)
      throw new AppError('VALIDATION_ERROR', {
        details: [{ path: 'endsAt', code: 'ORDER', message: 'End must be after start.' }],
      });
    if (input.endsAt <= this.clock.now())
      throw new AppError('VALIDATION_ERROR', {
        details: [{ path: 'endsAt', code: 'PAST', message: 'This closure is already over.' }],
      });
    if (input.endsAt.getTime() - input.startsAt.getTime() > 60 * 86_400_000)
      throw new AppError('VALIDATION_ERROR', {
        details: [
          {
            path: 'endsAt',
            code: 'TOO_LONG',
            message: 'At most 60 days; contact support for longer closures.',
          },
        ],
      });
    const h = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, branchId);
      const created = await tx.branchHoliday.create({
        data: {
          branchId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          reason: input.reason ?? null,
        },
      });
      await tx.branch.update({ where: { id: branchId }, data: { menuVersion: { increment: 1 } } });
      await this.audit.record(
        {
          action: 'branch.holiday_added',
          targetType: 'branch',
          targetId: branchId,
          actorUserId: actorId,
          after: { holidayId: created.id },
        },
        tx,
      );
      return created;
    });
    return { id: h.id, startsAt: h.startsAt, endsAt: h.endsAt, reason: h.reason };
  }

  /** API-MER-019 */
  async holidays(branchId: string) {
    const rows = await this.prisma.branchHoliday.findMany({
      where: { branchId, endsAt: { gt: this.clock.now() } },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map((h) => ({
      id: h.id,
      startsAt: h.startsAt,
      endsAt: h.endsAt,
      reason: h.reason,
    }));
  }

  /** API-MER-021 */
  async removeHoliday(actorId: string, branchId: string, holidayId: string) {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.branchHoliday.deleteMany({ where: { id: holidayId, branchId } });
      if (!count) throw new AppError('NOT_FOUND', { message: "We couldn't find that closure." });
      await tx.branch.update({ where: { id: branchId }, data: { menuVersion: { increment: 1 } } });
      await this.audit.record(
        {
          action: 'branch.holiday_removed',
          targetType: 'branch',
          targetId: branchId,
          actorUserId: actorId,
          after: { holidayId },
        },
        tx,
      );
    });
  }

  /** BR-REST-006: what still blocks going live. */
  async goLiveMissing(branchId: string) {
    const b = await this.prisma.branch.findUniqueOrThrow({
      where: { id: branchId },
      include: {
        restaurant: {
          select: { id: true, onboardingStatus: true, status: true, logoFileId: true },
        },
        _count: { select: { operatingHours: true } },
      },
    });
    const restaurantId = b.restaurantId;
    const [bank, categories] = await Promise.all([
      this.prisma.restaurantBankAccount.count({ where: { restaurantId, status: 'VERIFIED' } }),
      this.prisma.menuCategory.findMany({
        where: { restaurantId, isActive: true, deletedAt: null },
        select: {
          items: {
            where: {
              isHidden: false,
              deletedAt: null,
              NOT: { branchAvailability: { some: { branchId, isAvailable: false } } },
            },
            select: { id: true },
          },
        },
      }),
    ]);
    const out: { path: string; code: string; message: string }[] = [];
    const need = (ok: unknown, path: string, message: string) => {
      if (!ok) out.push({ path, code: 'MISSING', message });
    };
    need(
      b.restaurant.onboardingStatus === 'APPROVED' && b.restaurant.status === 'ACTIVE',
      'restaurant',
      'Restaurant approved and active',
    );
    need(b.status === 'ACTIVE', 'branch', 'Outlet approved');
    need(
      categories.some((c) => c.items.length >= 3),
      'menu',
      'A menu category with at least 3 available dishes',
    );
    need(b._count.operatingHours > 0, 'hours', 'Operating hours');
    need(bank > 0, 'bank', 'Verified bank account');
    need(b.restaurant.logoFileId, 'logo', 'Logo');
    return out;
  }

  /** API-MER-022 (FR-REST-014): go online. */
  async open(actorId: string, branchId: string) {
    const missing = await this.goLiveMissing(branchId);
    if (missing.length) throw new AppError('GO_LIVE_INCOMPLETE', { details: missing });
    await this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, branchId);
      if (b.isOpenManual) return;
      await tx.branch.update({ where: { id: branchId }, data: { isOpenManual: true } });
      await this.event(tx, branchId, 'OPENED', actorId);
    });
    return this.status(branchId);
  }

  /** Next day's first slot start, local time (for "closed for today"). */
  private async nextDayOpening(branchId: string): Promise<Date | null> {
    const b = await this.prisma.branch.findUniqueOrThrow({
      where: { id: branchId },
      select: { timezone: true, operatingHours: true },
    });
    const now = localParts(this.clock.now(), b.timezone);
    for (let add = 1; add <= 7; add++) {
      const day = new Date(Date.UTC(now.year, now.month - 1, now.day + add));
      const slots = b.operatingHours
        .filter((h) => h.weekday === day.getUTCDay())
        .map((h) => h.opensAt.getUTCHours() * 60 + h.opensAt.getUTCMinutes())
        .sort((x, y) => x - y);
      if (slots.length)
        return zonedInstant(
          day.getUTCFullYear(),
          day.getUTCMonth() + 1,
          day.getUTCDate(),
          slots[0]!,
          b.timezone,
        );
    }
    return null;
  }

  /** API-MER-023: offline for today (or until reopened, per setting). */
  async close(actorId: string, branchId: string, reason?: string) {
    const until = (await this.settings.get('restaurant.manualCloseUntilNextDay'))
      ? await this.nextDayOpening(branchId)
      : null;
    await this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, branchId);
      if (!b.isOpenManual) return;
      await tx.branch.update({ where: { id: branchId }, data: { isOpenManual: false } });
      await this.event(tx, branchId, 'CLOSED', actorId, { reason: reason ?? null, until });
    });
    return this.status(branchId);
  }

  /** API-MER-024 (FR-REST-015, BR-REST-002). In-flight orders are untouched. */
  async pause(
    actorId: string,
    branchId: string,
    input: { minutes?: number | undefined; reason: string },
  ) {
    const max = await this.settings.get('restaurant.pauseMaxMinutes');
    const minutes = input.minutes ?? max; // "until I resume" ends after the maximum
    const until = new Date(this.clock.now().getTime() + minutes * 60_000);
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, branchId);
      await tx.branch.update({
        where: { id: branchId },
        data: { pausedUntil: until, pauseReason: input.reason },
      });
      await this.event(tx, branchId, 'PAUSED', actorId, { reason: input.reason, until });
    });
    return this.status(branchId);
  }

  /** API-MER-025 */
  async resume(actorId: string | null, branchId: string, reason?: string) {
    await this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, branchId);
      if (!b.pausedUntil) return;
      await tx.branch.update({
        where: { id: branchId },
        data: { pausedUntil: null, pauseReason: null },
      });
      await this.event(tx, branchId, 'RESUMED', actorId, { reason: reason ?? null });
    });
    return this.status(branchId);
  }

  /** API-MER-026 (FR-REST-016): default prep time and a temporary rush adder (≤ 2 h). */
  async prepTime(
    actorId: string,
    branchId: string,
    input: {
      defaultPrepMinutes?: number | undefined;
      rush?: { extraMinutes: 0 | 10 | 20 | 30; forMinutes: number } | undefined;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, branchId);
      await tx.branch.update({
        where: { id: branchId },
        data: {
          ...(input.defaultPrepMinutes !== undefined
            ? { defaultPrepMinutes: input.defaultPrepMinutes }
            : {}),
          ...(input.rush
            ? input.rush.extraMinutes === 0
              ? { rushExtraMinutes: 0, rushUntil: null }
              : {
                  rushExtraMinutes: input.rush.extraMinutes,
                  rushUntil: new Date(this.clock.now().getTime() + input.rush.forMinutes * 60_000),
                }
            : {}),
          menuVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      await this.audit.record(
        {
          action: 'branch.prep_time_updated',
          targetType: 'branch',
          targetId: branchId,
          actorUserId: actorId,
          after: { ...input },
        },
        tx,
      );
    });
    return this.status(branchId);
  }

  /**
   * JOB-REST-001/002: pauses whose time ran out get a RESUMED entry, and
   * "closed for today" branches reopen at the next day's first slot.
   */
  async sweep(): Promise<{ resumed: number; reopened: number }> {
    const now = this.clock.now();
    let resumed = 0;
    let reopened = 0;
    const expired = await this.prisma.branch.findMany({
      where: { pausedUntil: { lte: now } },
      select: { id: true },
    });
    for (const b of expired) {
      await this.resume(null, b.id, 'Pause ended');
      resumed++;
    }
    const closed = await this.prisma.branch.findMany({
      where: { isOpenManual: false, status: 'ACTIVE', deletedAt: null },
      select: {
        id: true,
        // uuid v7 ids follow insertion order, unlike createdAt which callers may set.
        statusEvents: { orderBy: { id: 'desc' }, take: 1, select: { event: true, until: true } },
      },
    });
    for (const b of closed) {
      const last = b.statusEvents[0];
      if (last?.event !== 'CLOSED' || !last.until || last.until > now) continue;
      await this.prisma.$transaction(async (tx) => {
        const locked = await this.lock(tx, b.id);
        if (locked.isOpenManual) return;
        await tx.branch.update({ where: { id: b.id }, data: { isOpenManual: true } });
        await this.event(tx, b.id, 'OPENED', null, { reason: 'Reopened for the new day' });
      });
      reopened++;
    }
    if (resumed || reopened) this.logger.info({ resumed, reopened }, 'branch status sweep');
    return { resumed, reopened };
  }
}
