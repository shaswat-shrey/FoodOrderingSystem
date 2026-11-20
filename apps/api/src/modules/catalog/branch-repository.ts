import type { Prisma, PrismaClient } from '@fos/db';
import type { LatLng } from '../geo';
import { computeBranchStatus, type BranchStatus } from './branch-status';

const branchInclude = (now: Date) =>
  ({
    restaurant: {
      select: {
        id: true,
        brandName: true,
        slug: true,
        description: true,
        status: true,
        onboardingStatus: true,
        fssaiNumber: true,
        fssaiExpiresOn: true,
        pureVeg: true,
        ratingAvgBps: true,
        ratingCount: true,
        approvedAt: true,
        cuisines: {
          orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
          select: { cuisine: { select: { slug: true, name: true } } },
        },
      },
    },
    zone: {
      select: {
        id: true,
        name: true,
        status: true,
        maxDeliveryRadiusM: true,
        surgeAmount: true,
        surgeReason: true,
        surgeUntil: true,
      },
    },
    operatingHours: { select: { weekday: true, opensAt: true, closesAt: true } },
    holidays: {
      where: { endsAt: { gt: now } },
      select: { startsAt: true, endsAt: true, reason: true },
      orderBy: { startsAt: 'asc' },
    },
  }) satisfies Prisma.BranchInclude;

export type BranchRow = Prisma.BranchGetPayload<{ include: ReturnType<typeof branchInclude> }>;

export interface BranchRecord extends BranchRow {
  point: LatLng;
  computed: BranchStatus;
}

/** Loads branches with everything needed to compute their status (BR-REST-001). */
export class BranchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async load(ids: string[], now: Date): Promise<Map<string, BranchRecord>> {
    if (ids.length === 0) return new Map();
    const [rows, points] = await Promise.all([
      this.prisma.branch.findMany({ where: { id: { in: ids } }, include: branchInclude(now) }),
      this.prisma.$queryRaw<{ id: string; lat: number; lng: number }[]>`
        SELECT id, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
        FROM branches WHERE id = ANY(${ids}::uuid[])`,
    ]);
    const pointById = new Map(
      points.map((p) => [p.id, { lat: Number(p.lat), lng: Number(p.lng) }]),
    );
    const result = new Map<string, BranchRecord>();
    for (const row of rows) {
      result.set(row.id, {
        ...row,
        point: pointById.get(row.id) ?? { lat: 0, lng: 0 },
        computed: computeBranchStatus({
          now,
          timezone: row.timezone,
          restaurant: row.restaurant,
          branch: row,
          zoneStatus: row.zone.status,
          hours: row.operatingHours,
          holidays: row.holidays,
        }),
      });
    }
    return result;
  }

  async loadOne(id: string, now: Date): Promise<BranchRecord | null> {
    return (await this.load([id], now)).get(id) ?? null;
  }
}

export const isListed = (b: BranchRecord) => b.computed.state !== 'UNAVAILABLE';
