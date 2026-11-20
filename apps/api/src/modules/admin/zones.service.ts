import { Prisma, type PrismaClient, type ZoneStatus } from '@fos/db';
import { uuidv7 } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { AuditService } from '../audit';
import { isInIndia } from '../geo';
import { auditAs, pageArgs, pageMeta, type AdminActor, type Page } from './admin.http';

type Tx = Prisma.TransactionClient;

/** GeoJSON Polygon, outer ring only: `[[[lng, lat], …]]` (FR-ADMIN-070). */
export interface GeoPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

/** BR-PRICE-007: surge is a flat fee of at most ₹40, active for at most 3 hours. */
export const MAX_SURGE_AMOUNT = 4_000;
export const MAX_SURGE_HOURS = 3;

export interface ZoneInput {
  name: string;
  city: string;
  polygon: GeoPolygon;
  maxDeliveryRadiusM?: number | undefined;
  reason: string;
}

export interface ZonePatch {
  name?: string | undefined;
  city?: string | undefined;
  polygon?: GeoPolygon | undefined;
  maxDeliveryRadiusM?: number | undefined;
  rainMode?: boolean | undefined;
  reason: string;
}

interface ZoneRow {
  id: string;
  name: string;
  city: string;
  status: ZoneStatus;
  suspensionReason: string | null;
  maxDeliveryRadiusM: number;
  surgeAmount: number;
  surgeReason: string | null;
  surgeUntil: Date | null;
  rainMode: boolean;
  createdAt: Date;
  updatedAt: Date;
  polygon: string;
  areaKm2: number;
  branches: number;
}

const invalid = (message: string, code = 'INVALID_POLYGON') =>
  new AppError('VALIDATION_ERROR', { details: [{ path: 'polygon', code, message }] });

/**
 * Delivery zones (FR-ADMIN-070, API-ADM-120…126). Polygons are stored as
 * PostGIS geography; active zones never overlap (enforced by a trigger too).
 * Any change that affects serviceability refreshes the zone's branches.
 */
export class AdminZonesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private select(where: Prisma.Sql) {
    return Prisma.sql`
      SELECT z.id, z.name, z.city, z.status::text AS status, z.suspension_reason AS "suspensionReason",
        z.max_delivery_radius_m AS "maxDeliveryRadiusM", z.surge_amount AS "surgeAmount",
        z.surge_reason AS "surgeReason", z.surge_until AS "surgeUntil", z.rain_mode AS "rainMode",
        z.created_at AS "createdAt", z.updated_at AS "updatedAt",
        ST_AsGeoJSON(z.polygon)::text AS polygon,
        ROUND((ST_Area(z.polygon) / 1e6)::numeric, 2)::float8 AS "areaKm2",
        (SELECT count(*)::int FROM branches b WHERE b.zone_id = z.id AND b.deleted_at IS NULL) AS branches
      FROM zones z WHERE z.deleted_at IS NULL AND ${where}`;
  }

  private view(z: ZoneRow) {
    const now = this.clock.now();
    const surgeActive = z.surgeAmount > 0 && z.surgeUntil !== null && z.surgeUntil > now;
    return {
      id: z.id,
      name: z.name,
      city: z.city,
      status: z.status,
      suspensionReason: z.suspensionReason,
      maxDeliveryRadiusM: z.maxDeliveryRadiusM,
      rainMode: z.rainMode,
      surge: {
        active: surgeActive,
        amount: surgeActive ? z.surgeAmount : 0,
        reason: surgeActive ? z.surgeReason : null,
        until: surgeActive ? z.surgeUntil : null,
      },
      polygon: JSON.parse(z.polygon) as GeoPolygon,
      areaKm2: Number(z.areaKm2),
      branchCount: z.branches,
      createdAt: z.createdAt,
      updatedAt: z.updatedAt,
    };
  }

  /** API-ADM-120 */
  async list(filter: Page & { status?: ZoneStatus | undefined; city?: string | undefined }) {
    const where = Prisma.sql`(${filter.status ?? null}::"ZoneStatus" IS NULL OR z.status = ${filter.status ?? null}::"ZoneStatus")
      AND (${filter.city ?? null}::text IS NULL OR z.city ILIKE ${filter.city ?? null})`;
    const { skip, take } = pageArgs(filter);
    const [rows, [count]] = await Promise.all([
      this.prisma.$queryRaw<
        ZoneRow[]
      >`${this.select(where)} ORDER BY z.city, z.name, z.id LIMIT ${take} OFFSET ${skip}`,
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM zones z WHERE z.deleted_at IS NULL AND ${where}`,
    ]);
    return { items: rows.map((z) => this.view(z)), meta: pageMeta(filter, count?.n ?? 0) };
  }

  private async row(db: Tx | PrismaClient, id: string) {
    const [z] = await db.$queryRaw<ZoneRow[]>`${this.select(Prisma.sql`z.id = ${id}::uuid`)}`;
    if (!z) throw new AppError('NOT_FOUND', { message: "We couldn't find that zone." });
    return z;
  }

  /** API-ADM-122 */
  async detail(id: string) {
    return this.view(await this.row(this.prisma, id));
  }

  /**
   * A closed ring of distinct points inside India that PostGIS accepts as a
   * valid (non-self-intersecting) polygon. Returns the GeoJSON to store.
   */
  private async checkPolygon(db: Tx, polygon: GeoPolygon): Promise<string> {
    const [ring] = polygon.coordinates;
    if (!ring || polygon.coordinates.length !== 1)
      throw invalid('Draw one outer boundary (holes are not supported).');
    if (ring.length < 4) throw invalid('A zone needs at least three corners.');
    const [first, last] = [ring[0]!, ring.at(-1)!];
    if (first[0] !== last[0] || first[1] !== last[1])
      throw invalid('The boundary must be closed: the last point repeats the first.', 'NOT_CLOSED');
    if (ring.some(([lng, lat]) => !isInIndia({ lat, lng })))
      throw invalid('Every corner must be inside India.', 'OUTSIDE_INDIA');
    const json = JSON.stringify({ type: 'Polygon', coordinates: [ring] });
    const [check] = await db.$queryRaw<{ valid: boolean; why: string; area: number }[]>`
      SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS why,
        ST_Area(g::geography)::float8 AS area
      FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${json}), 4326) AS g) s`;
    if (!check?.valid)
      throw invalid(
        `The boundary crosses itself (${check?.why ?? 'invalid'}).`,
        'SELF_INTERSECTING',
      );
    if (check.area < 10_000) throw invalid('A zone must cover at least one hectare.', 'TOO_SMALL');
    return json;
  }

  /** FR-ADMIN-070: active zones must not overlap (touching edges are fine). */
  private async checkOverlap(db: Tx, id: string, json: string) {
    const [hit] = await db.$queryRaw<{ name: string }[]>`
      SELECT name FROM zones
      WHERE id <> ${id}::uuid AND status = 'ACTIVE' AND deleted_at IS NULL
        AND ST_Relate(polygon::geometry, ST_SetSRID(ST_GeomFromGeoJSON(${json}), 4326), 'T********')
      LIMIT 1`;
    if (hit)
      throw new AppError('RESOURCE_CONFLICT', {
        message: `This zone overlaps the active zone "${hit.name}".`,
        details: [{ path: 'polygon', code: 'OVERLAP', message: hit.name }],
      });
  }

  /** Listings, menus and quotes show zone facts: refresh every branch's caches (FR-MENUC-008). */
  private async touchBranches(tx: Tx, zoneId: string) {
    await tx.branch.updateMany({
      where: { zoneId },
      data: { menuVersion: { increment: 1 }, version: { increment: 1 } },
    });
  }

  /** The overlap trigger is the last line of defence against concurrent edits. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (String((error as Error)?.message ?? '').includes('overlaps another active zone'))
        throw new AppError('RESOURCE_CONFLICT', {
          message: 'This zone overlaps another active zone.',
        });
      throw error;
    }
  }

  private record(
    tx: Tx,
    actor: AdminActor,
    action: string,
    id: string,
    reason: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ) {
    return auditAs(
      this.audit,
      actor,
      { action, targetType: 'zone', targetId: id, reason, before, after, sensitivity: 'HIGH' },
      tx,
    );
  }

  /** API-ADM-121 ★ */
  async create(actor: AdminActor, input: ZoneInput) {
    const id = uuidv7();
    await this.guarded(() =>
      this.prisma.$transaction(async (tx) => {
        const json = await this.checkPolygon(tx, input.polygon);
        await this.checkOverlap(tx, id, json);
        await tx.$executeRaw`
          INSERT INTO zones (id, name, city, polygon, status, max_delivery_radius_m, updated_at)
          VALUES (${id}::uuid, ${input.name}, ${input.city},
            ST_SetSRID(ST_GeomFromGeoJSON(${json}), 4326)::geography, 'ACTIVE',
            ${input.maxDeliveryRadiusM ?? 7_000}, now())`;
        await this.record(
          tx,
          actor,
          'admin.zone_created',
          id,
          input.reason,
          {},
          {
            name: input.name,
            city: input.city,
            polygon: input.polygon,
            maxDeliveryRadiusM: input.maxDeliveryRadiusM ?? 7_000,
          },
        );
      }),
    );
    return this.detail(id);
  }

  /** API-ADM-123 ★: boundary and settings. Branches of the zone must stay inside it. */
  async update(actor: AdminActor, id: string, patch: ZonePatch) {
    await this.guarded(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM zones WHERE id = ${id}::uuid FOR UPDATE`;
        const z = await this.row(tx, id);
        if (patch.polygon) {
          const json = await this.checkPolygon(tx, patch.polygon);
          if (z.status === 'ACTIVE') await this.checkOverlap(tx, id, json);
          const [outside] = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM branches
            WHERE zone_id = ${id}::uuid AND deleted_at IS NULL
              AND NOT ST_Covers(ST_SetSRID(ST_GeomFromGeoJSON(${json}), 4326)::geography, location)`;
          if (outside && outside.n > 0)
            throw invalid(
              `${outside.n} branch(es) of this zone would fall outside the new boundary.`,
              'BRANCHES_OUTSIDE',
            );
          await tx.$executeRaw`
            UPDATE zones SET polygon = ST_SetSRID(ST_GeomFromGeoJSON(${json}), 4326)::geography,
              updated_at = now()
            WHERE id = ${id}::uuid`;
        }
        await tx.zone.update({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.city !== undefined ? { city: patch.city } : {}),
            ...(patch.maxDeliveryRadiusM !== undefined
              ? { maxDeliveryRadiusM: patch.maxDeliveryRadiusM }
              : {}),
            ...(patch.rainMode !== undefined ? { rainMode: patch.rainMode } : {}),
          },
        });
        await this.touchBranches(tx, id);
        const { reason: _, ...changes } = patch;
        await this.record(
          tx,
          actor,
          'admin.zone_updated',
          id,
          patch.reason,
          {
            name: z.name,
            city: z.city,
            maxDeliveryRadiusM: z.maxDeliveryRadiusM,
            rainMode: z.rainMode,
            ...(patch.polygon ? { polygon: JSON.parse(z.polygon) } : {}),
          },
          changes,
        );
      }),
    );
    return this.detail(id);
  }

  /** API-ADM-124/125 ★: SUSPENDED zones are not serviceable (BR-GEO-001 a). */
  async setStatus(actor: AdminActor, id: string, to: 'ACTIVE' | 'SUSPENDED', reason: string) {
    await this.guarded(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM zones WHERE id = ${id}::uuid FOR UPDATE`;
        const z = await this.row(tx, id);
        if (z.status === to)
          throw new AppError('RESOURCE_CONFLICT', {
            message: `This zone is already ${to.toLowerCase()}.`,
          });
        if (to === 'ACTIVE') {
          const [geo] = await tx.$queryRaw<{ json: string }[]>`
            SELECT ST_AsGeoJSON(polygon)::text AS json FROM zones WHERE id = ${id}::uuid`;
          await this.checkOverlap(tx, id, geo!.json);
        }
        await tx.zone.update({
          where: { id },
          data: { status: to, suspensionReason: to === 'SUSPENDED' ? reason.slice(0, 300) : null },
        });
        await this.touchBranches(tx, id);
        await this.record(
          tx,
          actor,
          to === 'SUSPENDED' ? 'admin.zone_suspended' : 'admin.zone_activated',
          id,
          reason,
          { status: z.status },
          { status: to },
        );
      }),
    );
    return this.detail(id);
  }

  /**
   * API-ADM-126 ★ (BR-PRICE-007): a flat surge for a few hours, shown to
   * customers with its reason and paid to partners as the zone bonus. Zero clears it.
   */
  async setSurge(
    actor: AdminActor,
    id: string,
    input: { amount: number; until?: Date | undefined; label?: string | undefined; reason: string },
  ) {
    const now = this.clock.now();
    const clearing = input.amount === 0;
    if (!clearing) {
      const details = [];
      if (!input.until || input.until <= now)
        details.push({ path: 'until', code: 'PAST', message: 'Surge must end in the future.' });
      else if (input.until.getTime() - now.getTime() > MAX_SURGE_HOURS * 3_600_000)
        details.push({
          path: 'until',
          code: 'TOO_LONG',
          message: `Surge lasts at most ${MAX_SURGE_HOURS} hours per activation.`,
        });
      if (!input.label)
        details.push({
          path: 'label',
          code: 'REQUIRED',
          message: 'Tell customers why (for example "Heavy rain").',
        });
      if (details.length) throw new AppError('VALIDATION_ERROR', { details });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM zones WHERE id = ${id}::uuid FOR UPDATE`;
      const z = await this.row(tx, id);
      const data = clearing
        ? { surgeAmount: 0, surgeUntil: null, surgeReason: null }
        : { surgeAmount: input.amount, surgeUntil: input.until!, surgeReason: input.label! };
      await tx.zone.update({ where: { id }, data });
      await this.touchBranches(tx, id);
      await this.record(
        tx,
        actor,
        'admin.zone_surge_set',
        id,
        input.reason,
        { amount: z.surgeAmount, until: z.surgeUntil, label: z.surgeReason },
        { amount: data.surgeAmount, until: data.surgeUntil, label: data.surgeReason },
      );
    });
    return this.detail(id);
  }
}
