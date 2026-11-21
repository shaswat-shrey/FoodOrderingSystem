import type { PrismaClient } from '@fos/db';
import type { Redis } from 'ioredis';
import { softRedis } from '../../platform/redis';
import type { Clock } from '../../platform/clock';
import { raiseOpsAlert } from '../../platform/ops-alerts';
import type { Realtime } from '../../platform/realtime/publisher';
import type { EstimatedRouting } from '../geo';
import type { Fix, PresenceStore } from '../partners';

/** BR-DEL-012: the partner is visible to the customer from assignment until delivery. */
const SHARED = ['ASSIGNED', 'AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'] as const;
const FANOUT_MS = 3_000; // FR-TRK-006
const ETA_EVERY_MS = 60_000; // FR-TRK-007
const ETA_CHANGE_MS = 2 * 60_000;
const DROP_BUFFER_MS = 3 * 60_000; // DELIVERY-ASSIGNMENT-ALGORITHM §9
const STALE_MS = 60_000; // FR-TRK-005
const OPS_STALE_MS = 5 * 60_000;

/** Live tracking fan-out, ETA updates and stale detection (FR-TRK-004…007, EVT-TRK-001…003). */
export class LiveTracking {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly realtime: Realtime,
    private readonly presence: PresenceStore,
    private readonly routing: EstimatedRouting,
    private readonly clock: Clock,
  ) {}

  private once(key: string, ms: number) {
    return softRedis(this.redis, (r) => r.set(key, '1', 'PX', ms, 'NX'), null).then(
      (r) => r === 'OK',
    );
  }

  /** A fix from the partner app (socket or REST batch). */
  async onLocation(partnerId: string, deliveryId: string | null, fix: Fix & { at: number }) {
    if (!deliveryId) return;
    const d = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        status: true,
        partnerId: true,
        orderId: true,
        order: { select: { etaMinAt: true, etaMaxAt: true, version: true } },
      },
    });
    if (!d || d.partnerId !== partnerId || !(SHARED as readonly string[]).includes(d.status))
      return;
    await softRedis(this.redis, (r) => r.del(`trk:stale:${deliveryId}`), 0);
    if (await this.once(`trk:fanout:${d.orderId}`, FANOUT_MS))
      await this.realtime.push({
        app: 'CUSTOMER',
        rooms: [`order:${d.orderId}`],
        event: 'tracking.location',
        aggregate: { type: 'delivery', id: deliveryId, version: 0 },
        data: {
          lat: fix.lat,
          lng: fix.lng,
          heading: fix.heading ?? null,
          accuracy: fix.accuracyM,
          recordedAt: new Date(fix.at).toISOString(),
          stale: false,
        },
      });
    if (
      d.status === 'EN_ROUTE_TO_CUSTOMER' &&
      (await this.once(`trk:eta:${d.orderId}`, ETA_EVERY_MS))
    )
      await this.refreshEta(d.orderId, deliveryId, fix, d.order);
  }

  private async refreshEta(
    orderId: string,
    deliveryId: string,
    fix: Fix,
    order: { etaMinAt: Date | null; etaMaxAt: Date | null; version: number },
  ) {
    const [drop] = await this.prisma.$queryRaw<{ lat: number; lng: number }[]>`
      SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM order_addresses WHERE order_id = ${orderId}::uuid`;
    if (!drop) return;
    const route = await this.routing.route({ lat: fix.lat, lng: fix.lng }, drop);
    const now = this.clock.now().getTime();
    const minAt = new Date(now + route.durationS * 1000 + DROP_BUFFER_MS);
    const maxAt = new Date(minAt.getTime() + 5 * 60_000);
    await this.realtime.push({
      app: 'CUSTOMER',
      rooms: [`order:${orderId}`],
      event: 'tracking.eta',
      aggregate: { type: 'delivery', id: deliveryId, version: 0 },
      data: {
        etaMinutes: Math.ceil((minAt.getTime() - now) / 60_000),
        distanceRemainingKm: Math.round(route.distanceM / 100) / 10,
      },
    });
    if (order.etaMaxAt && Math.abs(order.etaMaxAt.getTime() - maxAt.getTime()) < ETA_CHANGE_MS)
      return;
    await this.prisma.order.update({
      where: { id: orderId },
      data: { etaMinAt: minAt, etaMaxAt: maxAt },
    });
    await this.realtime.push({
      app: 'CUSTOMER',
      rooms: [`order:${orderId}`],
      event: 'order.eta_updated',
      aggregate: { type: 'order', id: orderId, version: order.version },
      data: { eta: { minAt: minAt.toISOString(), maxAt: maxAt.toISOString() }, reason: 'TRAFFIC' },
    });
  }

  /** FR-TRK-005: "Location updating…" after 60 s; ops alert after 5 min. Runs every minute. */
  async sweepStale() {
    const now = this.clock.now().getTime();
    const live = await this.prisma.delivery.findMany({
      where: { status: { in: [...SHARED] }, partnerId: { not: null } },
      select: { id: true, orderId: true, partnerId: true, branch: { select: { zoneId: true } } },
      take: 2_000,
    });
    let stale = 0;
    for (const d of live) {
      const p = await this.presence.get(d.partnerId!);
      const lastSeen = p?.at ?? 0;
      if (!lastSeen || now - lastSeen < STALE_MS) continue;
      stale++;
      const lastSeenAt = new Date(lastSeen).toISOString();
      if (await this.once(`trk:stale:${d.id}`, 10 * 60_000))
        await this.realtime.push({
          app: 'CUSTOMER',
          rooms: [`order:${d.orderId}`],
          event: 'tracking.stale',
          aggregate: { type: 'delivery', id: d.id, version: 0 },
          data: { lastSeenAt },
        });
      if (
        now - lastSeen >= OPS_STALE_MS &&
        (await this.once(`trk:ops-stale:${d.id}`, 30 * 60_000))
      ) {
        await raiseOpsAlert(this.prisma, {
          type: 'STALE_PARTNER',
          severity: 'WARNING',
          refType: 'delivery',
          refId: d.id,
          message: 'No location from the assigned partner for 5 minutes.',
          dedupeKey: `stale:${d.id}`,
        });
        await this.realtime.push({
          app: 'ADMIN',
          rooms: ['admin:ops', `admin:zone:${d.branch.zoneId}`],
          event: 'ops.partner_stale',
          aggregate: { type: 'delivery', id: d.id, version: 0 },
          data: { partnerId: d.partnerId, deliveryId: d.id, lastSeenAt },
        });
      }
    }
    return { stale };
  }
}
