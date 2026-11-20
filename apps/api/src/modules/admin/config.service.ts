import type { Prisma, PriceComponent, PrismaClient, TaxCode, TaxCollector } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { AuditService } from '../audit';
import {
  isSettingKey,
  SETTING_DEFINITIONS,
  settingDefinition,
  type SettingKey,
  type SettingsService,
} from '../config';
import { auditAs, pageArgs, pageMeta, type AdminActor, type Page } from './admin.http';

type Tx = Prisma.TransactionClient;

/** Effective-dated configs may start now (a minute of clock skew allowed) or later (FR-CFG-002). */
const SKEW_MS = 60_000;

export interface FeeScheduleInput {
  zoneId?: string | null | undefined;
  platformFeeAmount: number;
  smallOrderThresholdAmount: number;
  smallOrderFeeAmount: number;
  perKmBeyondSlabsAmount: number;
  packagingCapPerItemAmount: number;
  packagingCapPerOrderAmount: number;
  surgeCapAmount: number;
  slabs: { fromM: number; toM: number; feeAmount: number }[];
  effectiveFrom?: Date | undefined;
  reason: string;
}

export interface TaxRuleInput {
  component: PriceComponent;
  taxCode: TaxCode;
  rateBps: number;
  collectedBy: TaxCollector;
  effectiveFrom?: Date | undefined;
  reason: string;
}

export interface CommissionPlanInput {
  name: string;
  rateBps: number;
  effectiveFrom?: Date | undefined;
  reason: string;
}

export interface PayPlanInput {
  zoneId?: string | null | undefined;
  baseAmount: number;
  perKmAmount: number;
  freeKmM: number;
  waitAfterMinutes: number;
  perWaitMinuteAmount: number;
  waitCapAmount: number;
  rainBonusAmount: number;
  cancellationMinAmount: number;
  effectiveFrom?: Date | undefined;
  reason: string;
}

const issue = (path: string, code: string, message: string) =>
  new AppError('VALIDATION_ERROR', { details: [{ path, code, message }] });

/**
 * Platform configuration (FR-ADMIN-071/072/073/100/122, API-ADM-130…140 and
 * 196…198): typed settings with history, the effective-dated pricing tables
 * (append-only — a change is a new version) and the cuisine catalogue.
 */
export class AdminConfigService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /* ------------------------------ settings ------------------------------ */

  /** API-ADM-130: every registered key with its effective value, default and description. */
  async listSettings() {
    const rows = new Map(
      (await this.prisma.platformSetting.findMany()).map((r) => [r.key, r] as const),
    );
    return (Object.keys(SETTING_DEFINITIONS) as SettingKey[]).sort().map((key) => {
      const def = settingDefinition(key);
      const row = rows.get(key);
      const stored = row ? def.schema.safeParse(row.value) : null;
      return {
        key,
        description: def.description,
        critical: Boolean(def.critical || row?.isCritical),
        default: def.default,
        value: stored?.success ? stored.data : def.default,
        // A stored value that fails its schema is ignored (SettingsService), so say so.
        storedValueInvalid: stored ? !stored.success : false,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    });
  }

  private knownKey(key: string): SettingKey {
    if (!isSettingKey(key))
      throw new AppError('NOT_FOUND', { message: `There is no setting called ${key}.` });
    return key;
  }

  /** API-ADM-131 ★: validated by the key's schema; critical keys need a super admin (FR-ADMIN-100). */
  async updateSetting(actor: AdminActor, rawKey: string, value: unknown, reason: string) {
    const key = this.knownKey(rawKey);
    const def = settingDefinition(key);
    const parsed = def.schema.safeParse(value);
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', {
        details: parsed.error.issues.map((i) => ({
          path: ['value', ...i.path.map(String)].join('.'),
          code: i.code.toUpperCase(),
          message: i.message,
        })),
      });
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT key FROM platform_settings WHERE key = ${key} FOR UPDATE`;
      const row = await tx.platformSetting.findUnique({ where: { key } });
      const critical = Boolean(def.critical || row?.isCritical);
      if (critical && !actor.roles.includes('SUPER_ADMIN'))
        throw new AppError('FORBIDDEN', {
          message: 'Only a super admin can change this critical setting.',
        });
      const newValue = parsed.data as Prisma.InputJsonValue;
      await tx.platformSetting.upsert({
        where: { key },
        create: { key, value: newValue, isCritical: critical, updatedBy: actor.userId },
        update: { value: newValue, isCritical: critical, updatedBy: actor.userId },
      });
      await tx.platformSettingHistory.create({
        data: {
          key,
          oldValue: (row?.value ?? undefined) as Prisma.InputJsonValue | undefined,
          newValue,
          changedBy: actor.userId,
          reason,
          createdAt: this.clock.now(),
        },
      });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.setting_updated',
          targetType: 'setting',
          targetId: key,
          reason,
          before: { value: row?.value ?? def.default },
          after: { value: parsed.data },
          sensitivity: 'HIGH',
        },
        tx,
      );
    });
    this.settings.invalidate(key);
    return (await this.listSettings()).find((s) => s.key === key)!;
  }

  /** API-ADM-132 (FR-CFG-001): newest first. */
  async settingHistory(rawKey: string, page: Page) {
    const key = this.knownKey(rawKey);
    const [rows, total] = await Promise.all([
      this.prisma.platformSettingHistory.findMany({
        where: { key },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(page),
        include: { changer: { select: { id: true, fullName: true } } },
      }),
      this.prisma.platformSettingHistory.count({ where: { key } }),
    ]);
    return {
      items: rows.map((h) => ({
        id: h.id,
        oldValue: h.oldValue,
        newValue: h.newValue,
        reason: h.reason,
        changedBy: h.changer,
        createdAt: h.createdAt,
      })),
      meta: pageMeta(page, total),
    };
  }

  /* ------------------------ effective-dated pricing ------------------------ */

  private effectiveFrom(at: Date | undefined): Date {
    const now = this.clock.now();
    const from = at ?? now;
    if (from.getTime() < now.getTime() - SKEW_MS)
      throw issue(
        'effectiveFrom',
        'PAST',
        'A new version can start now or later, never in the past.',
      );
    return from;
  }

  private async zoneExists(db: Tx, zoneId: string | null | undefined) {
    if (!zoneId) return;
    if (!(await db.zone.findFirst({ where: { id: zoneId, deletedAt: null } })))
      throw issue('zoneId', 'UNKNOWN', 'Unknown zone.');
  }

  /** Which version is in effect now for each scope key; later ones are scheduled. */
  private states<T extends { id: string; effectiveFrom: Date }>(
    rows: T[],
    scope: (r: T) => string,
  ) {
    const now = this.clock.now();
    const current = new Map<string, string>();
    for (const r of [...rows].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime()))
      if (r.effectiveFrom <= now && !current.has(scope(r))) current.set(scope(r), r.id);
    return (r: T) =>
      r.effectiveFrom > now
        ? 'SCHEDULED'
        : current.get(scope(r)) === r.id
          ? 'IN_EFFECT'
          : 'SUPERSEDED';
  }

  private record(
    tx: Tx,
    actor: AdminActor,
    action: string,
    targetType: string,
    id: string,
    reason: string,
    after: Record<string, unknown>,
  ) {
    return auditAs(
      this.audit,
      actor,
      { action, targetType, targetId: id, reason, after, sensitivity: 'HIGH' },
      tx,
    );
  }

  /** API-ADM-133 */
  async feeSchedules(filter: { zoneId?: string | undefined }) {
    const rows = await this.prisma.feeSchedule.findMany({
      where: filter.zoneId ? { OR: [{ zoneId: filter.zoneId }, { zoneId: null }] } : {},
      include: { deliverySlabs: { orderBy: { fromM: 'asc' } } },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    });
    const state = this.states(rows, (r) => r.zoneId ?? 'default');
    return rows.map((row) => {
      const { deliverySlabs, ...r } = row;
      return {
        ...r,
        slabs: deliverySlabs.map((s) => ({ fromM: s.fromM, toM: s.toM, feeAmount: s.feeAmount })),
        state: state(row),
      };
    });
  }

  /** API-ADM-134 ★ (BR-PRICE-003…007): contiguous slabs from 0 m; surge cap ≤ ₹40. */
  async createFeeSchedule(actor: AdminActor, input: FeeScheduleInput) {
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);
    const slabs = [...input.slabs].sort((a, b) => a.fromM - b.fromM);
    if (slabs[0]?.fromM !== 0)
      throw issue('slabs', 'NOT_FROM_ZERO', 'The first slab starts at 0 m.');
    slabs.forEach((s, i) => {
      if (s.toM <= s.fromM) throw issue(`slabs.${i}`, 'EMPTY', 'A slab must end after it starts.');
      const next = slabs[i + 1];
      if (next && next.fromM !== s.toM)
        throw issue(
          `slabs.${i + 1}`,
          'GAP',
          'Slabs must be contiguous (each starts where the last ended).',
        );
    });
    if (input.smallOrderFeeAmount > 0 && input.smallOrderThresholdAmount === 0)
      throw issue('smallOrderThresholdAmount', 'REQUIRED', 'A small-order fee needs a threshold.');
    if (input.packagingCapPerItemAmount > input.packagingCapPerOrderAmount)
      throw issue(
        'packagingCapPerItemAmount',
        'OUT_OF_RANGE',
        'The per-item cap exceeds the per-order cap.',
      );
    const created = await this.prisma.$transaction(async (tx) => {
      await this.zoneExists(tx, input.zoneId);
      if (
        await tx.feeSchedule.findFirst({ where: { zoneId: input.zoneId ?? null, effectiveFrom } })
      )
        throw new AppError('RESOURCE_CONFLICT', {
          message: 'A fee schedule already starts at that moment for this zone.',
        });
      const { reason, slabs: _, effectiveFrom: __, ...fees } = input;
      const row = await tx.feeSchedule.create({
        data: {
          ...fees,
          zoneId: input.zoneId ?? null,
          effectiveFrom,
          createdBy: actor.userId,
          deliverySlabs: { create: slabs },
        },
      });
      await this.record(tx, actor, 'admin.fee_schedule_created', 'fee_schedule', row.id, reason, {
        ...fees,
        zoneId: row.zoneId,
        slabs,
        effectiveFrom: effectiveFrom.toISOString(),
      });
      return row.id;
    });
    return (await this.feeSchedules({})).find((r) => r.id === created)!;
  }

  /** API-ADM-135 */
  async taxRules() {
    const rows = await this.prisma.taxRule.findMany({
      orderBy: [{ component: 'asc' }, { effectiveFrom: 'desc' }],
    });
    const state = this.states(rows, (r) => r.component);
    return rows.map((r) => ({ ...r, state: state(r) }));
  }

  /** API-ADM-136 ★ (BR-PRICE-009): one rule per component and moment. */
  async createTaxRule(actor: AdminActor, input: TaxRuleInput) {
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);
    const id = await this.prisma.$transaction(async (tx) => {
      if (await tx.taxRule.findFirst({ where: { component: input.component, effectiveFrom } }))
        throw new AppError('RESOURCE_CONFLICT', {
          message: 'A tax rule for this component already starts at that moment.',
        });
      const { reason, ...rule } = input;
      const row = await tx.taxRule.create({
        data: { ...rule, effectiveFrom, createdBy: actor.userId },
      });
      await this.record(tx, actor, 'admin.tax_rule_created', 'tax_rule', row.id, reason, {
        ...rule,
        effectiveFrom: effectiveFrom.toISOString(),
      });
      return row.id;
    });
    return (await this.taxRules()).find((r) => r.id === id)!;
  }

  /** API-ADM-137: the platform default; per-restaurant overrides are API-ADM-037. */
  async commissionPlans() {
    const rows = await this.prisma.commissionPlan.findMany({ orderBy: { effectiveFrom: 'desc' } });
    const state = this.states(rows, () => 'default');
    return rows.map((r) => ({ ...r, state: state(r) }));
  }

  /** API-ADM-138 ★ (BR-COMM-001). */
  async createCommissionPlan(actor: AdminActor, input: CommissionPlanInput) {
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);
    const id = await this.prisma.$transaction(async (tx) => {
      if (await tx.commissionPlan.findFirst({ where: { effectiveFrom } }))
        throw new AppError('RESOURCE_CONFLICT', {
          message: 'A commission plan already starts at that moment.',
        });
      const row = await tx.commissionPlan.create({
        data: { name: input.name, rateBps: input.rateBps, effectiveFrom, createdBy: actor.userId },
      });
      await this.record(
        tx,
        actor,
        'admin.commission_plan_created',
        'commission_plan',
        row.id,
        input.reason,
        {
          name: input.name,
          rateBps: input.rateBps,
          effectiveFrom: effectiveFrom.toISOString(),
        },
      );
      return row.id;
    });
    return (await this.commissionPlans()).find((r) => r.id === id)!;
  }

  /** API-ADM-139 */
  async payPlans(filter: { zoneId?: string | undefined }) {
    const rows = await this.prisma.partnerPayPlan.findMany({
      where: filter.zoneId ? { OR: [{ zoneId: filter.zoneId }, { zoneId: null }] } : {},
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    });
    const state = this.states(rows, (r) => r.zoneId ?? 'default');
    return rows.map((r) => ({ ...r, state: state(r) }));
  }

  /** API-ADM-140 ★ (BR-EARN-001). */
  async createPayPlan(actor: AdminActor, input: PayPlanInput) {
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);
    const id = await this.prisma.$transaction(async (tx) => {
      await this.zoneExists(tx, input.zoneId);
      if (
        await tx.partnerPayPlan.findFirst({
          where: { zoneId: input.zoneId ?? null, effectiveFrom },
        })
      )
        throw new AppError('RESOURCE_CONFLICT', {
          message: 'A pay plan already starts at that moment for this zone.',
        });
      const { reason, effectiveFrom: _, ...plan } = input;
      const row = await tx.partnerPayPlan.create({
        data: { ...plan, zoneId: input.zoneId ?? null, effectiveFrom, createdBy: actor.userId },
      });
      await this.record(tx, actor, 'admin.pay_plan_created', 'partner_pay_plan', row.id, reason, {
        ...plan,
        zoneId: row.zoneId,
        effectiveFrom: effectiveFrom.toISOString(),
      });
      return row.id;
    });
    return (await this.payPlans({})).find((r) => r.id === id)!;
  }

  /* ------------------------------ cuisines ------------------------------ */

  /** API-ADM-196 */
  async cuisines() {
    const rows = await this.prisma.cuisine.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { restaurants: true } } },
    });
    return rows.map(({ _count, ...c }) => ({ ...c, restaurantCount: _count.restaurants }));
  }

  /** Restaurant cards show cuisine names: refresh the branches that list this one. */
  private async touchCuisine(tx: Tx, cuisineId: string) {
    await tx.branch.updateMany({
      where: { restaurant: { cuisines: { some: { cuisineId } } } },
      data: { menuVersion: { increment: 1 }, version: { increment: 1 } },
    });
  }

  /** API-ADM-197 */
  async createCuisine(actor: AdminActor, input: { name: string; slug?: string | undefined }) {
    const slug =
      input.slug ??
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    if (!slug) throw issue('slug', 'REQUIRED', 'Give the cuisine a URL slug.');
    const row = await this.prisma.$transaction(async (tx) => {
      if (
        await tx.cuisine.findFirst({
          where: { OR: [{ slug }, { name: { equals: input.name, mode: 'insensitive' } }] },
        })
      )
        throw new AppError('RESOURCE_CONFLICT', { message: 'That cuisine already exists.' });
      const c = await tx.cuisine.create({ data: { name: input.name, slug } });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.cuisine_created',
          targetType: 'cuisine',
          targetId: c.id,
          after: { name: c.name, slug: c.slug },
          sensitivity: 'NORMAL',
        },
        tx,
      );
      return c;
    });
    return { ...row, restaurantCount: 0 };
  }

  /** API-ADM-198: rename or (de)activate; inactive cuisines can't be chosen for restaurants. */
  async updateCuisine(
    actor: AdminActor,
    id: string,
    patch: { name?: string | undefined; isActive?: boolean | undefined },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.cuisine.findUnique({ where: { id } });
      if (!c) throw new AppError('NOT_FOUND', { message: "We couldn't find that cuisine." });
      if (
        patch.name &&
        (await tx.cuisine.findFirst({
          where: { id: { not: id }, name: { equals: patch.name, mode: 'insensitive' } },
        }))
      )
        throw new AppError('RESOURCE_CONFLICT', { message: 'Another cuisine has that name.' });
      await tx.cuisine.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        },
      });
      await this.touchCuisine(tx, id);
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.cuisine_updated',
          targetType: 'cuisine',
          targetId: id,
          before: { name: c.name, isActive: c.isActive },
          after: patch,
          sensitivity: 'NORMAL',
        },
        tx,
      );
    });
    return (await this.cuisines()).find((c) => c.id === id)!;
  }
}
