import type { PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { SettingsService } from '../config';
import type { LatLng, RoutingProvider } from '../geo';
import { isListed, type BranchRecord, type BranchRepository } from './branch-repository';
import { deliveryFeeFor, etaRange, surgeFor, type FeeScheduleView } from './delivery-quote';

export type ServiceabilityReason =
  'OUTSIDE_ZONE' | 'OUTSIDE_RADIUS' | 'BRANCH_CLOSED' | 'BRANCH_PAUSED' | 'ZONE_SUSPENDED';

export interface ZoneHit {
  id: string;
  name: string;
  city: string;
  status: string;
}

export interface DeliveryInfo {
  serviceable: boolean;
  reason: ServiceabilityReason | null;
  distanceKm: number;
  eta: { minMinutes: number; maxMinutes: number };
  deliveryFeeAmount: number;
  surge: { amount: number; reason: string | null };
  minOrderAmount: number;
  maxOrderAmount: number | null;
  smallOrderThresholdAmount: number;
  smallOrderFeeAmount: number;
  platformFeeAmount: number;
}

const FEE_CACHE_MS = 30_000;

/** BR-GEO-001 (a)–(c) + (e) and the listing-time delivery numbers (FR-DISC-009). */
export class ServiceabilityService {
  private feeCache = new Map<string, { value: FeeScheduleView; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly branches: BranchRepository,
    private readonly routing: RoutingProvider,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /** The zone covering a point. Points on a shared edge prefer an ACTIVE zone. */
  async zoneAt(point: LatLng): Promise<ZoneHit | null> {
    const rows = await this.prisma.$queryRaw<ZoneHit[]>`
      SELECT id, name, city, status::text AS status
      FROM zones
      WHERE deleted_at IS NULL
        AND ST_Covers(polygon, ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography)
      ORDER BY (status = 'ACTIVE') DESC, created_at
      LIMIT 1`;
    return rows[0] ?? null;
  }

  /** API-GEO-004 / FR-LOC-006. */
  async check(point: LatLng, branchId?: string) {
    const zone = await this.zoneAt(point);
    const zoneView = zone ? { id: zone.id, name: zone.name, city: zone.city } : null;
    if (!zone)
      return { serviceable: false, reason: 'OUTSIDE_ZONE' as const, zone: null, branch: null };
    if (zone.status !== 'ACTIVE') {
      return {
        serviceable: false,
        reason: 'ZONE_SUSPENDED' as const,
        zone: zoneView,
        branch: null,
      };
    }
    if (!branchId) return { serviceable: true, reason: null, zone: zoneView, branch: null };

    const branch = await this.listedBranch(branchId);
    const straightLineM = await this.straightLineM(branch.id, point);
    const info = await this.deliveryInfo(branch, point, straightLineM, zone.id);
    return { serviceable: info.serviceable, reason: info.reason, zone: zoneView, branch: info };
  }

  async listedBranch(branchId: string): Promise<BranchRecord> {
    const branch = await this.branches.loadOne(branchId, this.clock.now());
    if (!branch || !isListed(branch))
      throw new AppError('NOT_FOUND', { message: "We couldn't find that restaurant." });
    return branch;
  }

  async straightLineM(branchId: string, point: LatLng): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ d: number }[]>`
      SELECT ST_Distance(location, ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography) AS d
      FROM branches WHERE id = ${branchId}::uuid`;
    return Number(row?.d ?? Number.POSITIVE_INFINITY);
  }

  /**
   * Delivery numbers for a branch and a location. `locationZoneId` is the zone
   * covering the location (BR-GEO-001 b: same zone as the branch).
   */
  async deliveryInfo(
    branch: BranchRecord,
    point: LatLng,
    straightLineM: number,
    locationZoneId: string | null,
  ): Promise<DeliveryInfo> {
    const now = this.clock.now();
    const [route, schedule, buffer, range] = await Promise.all([
      this.routing.route(branch.point, point),
      this.feeSchedule(branch.zoneId),
      this.settings.get('discovery.etaBufferMinutes'),
      this.settings.get('discovery.etaRangeMinutes'),
    ]);
    const radiusM = Math.min(branch.deliveryRadiusM, branch.zone.maxDeliveryRadiusM); // BR-GEO-002
    const rush = branch.rushUntil && branch.rushUntil > now ? branch.rushExtraMinutes : 0;

    let reason: ServiceabilityReason | null = null;
    if (locationZoneId !== branch.zoneId) reason = 'OUTSIDE_ZONE';
    else if (straightLineM > radiusM) reason = 'OUTSIDE_RADIUS';
    else if (!branch.computed.acceptingOrders) reason = reasonFor(branch);

    return {
      serviceable: reason === null,
      reason,
      distanceKm: Math.round(straightLineM / 100) / 10,
      eta: etaRange({
        prepMinutes: branch.avgPrepMinutes14d ?? branch.defaultPrepMinutes,
        rushExtraMinutes: rush,
        travelSeconds: route.durationS,
        bufferMinutes: buffer,
        rangeMinutes: range,
      }),
      deliveryFeeAmount: deliveryFeeFor(route.distanceM, schedule), // BR-GEO-003: road distance
      surge: surgeFor(branch.zone, schedule.surgeCapAmount, now),
      minOrderAmount: branch.minOrderAmount,
      maxOrderAmount: branch.maxOrderAmount,
      smallOrderThresholdAmount: schedule.smallOrderThresholdAmount,
      smallOrderFeeAmount: schedule.smallOrderFeeAmount,
      platformFeeAmount: schedule.platformFeeAmount,
    };
  }

  /** FR-CFG-002: latest schedule in effect for the zone, else the platform-wide one. */
  async feeSchedule(zoneId: string): Promise<FeeScheduleView> {
    const cached = this.feeCache.get(zoneId);
    const nowMs = this.clock.now().getTime();
    if (cached && cached.expiresAt > nowMs) return cached.value;
    const row = await this.prisma.feeSchedule.findFirst({
      where: { effectiveFrom: { lte: this.clock.now() }, OR: [{ zoneId }, { zoneId: null }] },
      orderBy: [{ zoneId: { sort: 'asc', nulls: 'last' } }, { effectiveFrom: 'desc' }],
      include: { deliverySlabs: true },
    });
    if (!row)
      throw new AppError('SERVICE_UNAVAILABLE', { message: 'Delivery fees are not configured.' });
    const value: FeeScheduleView = {
      id: row.id,
      slabs: row.deliverySlabs.map((s) => ({ fromM: s.fromM, toM: s.toM, feeAmount: s.feeAmount })),
      perKmBeyondSlabsAmount: row.perKmBeyondSlabsAmount,
      smallOrderThresholdAmount: row.smallOrderThresholdAmount,
      smallOrderFeeAmount: row.smallOrderFeeAmount,
      platformFeeAmount: row.platformFeeAmount,
      surgeCapAmount: row.surgeCapAmount,
      packagingCapPerItemAmount: row.packagingCapPerItemAmount,
      packagingCapPerOrderAmount: row.packagingCapPerOrderAmount,
    };
    this.feeCache.set(zoneId, { value, expiresAt: nowMs + FEE_CACHE_MS });
    return value;
  }
}

export function reasonFor(branch: BranchRecord): ServiceabilityReason | null {
  switch (branch.computed.reason) {
    case null:
      return null;
    case 'ZONE_SUSPENDED':
      return 'ZONE_SUSPENDED';
    case 'PAUSED':
    case 'FSSAI_EXPIRED':
      return 'BRANCH_PAUSED';
    default:
      return 'BRANCH_CLOSED';
  }
}
