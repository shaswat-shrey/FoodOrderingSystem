import type { PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { deliveryCode } from '../orders';
import type { PresenceStore } from '../partners';

/** A partner's location is visible to the customer only during these stages (BR-DEL-012). */
const SHARED = new Set(['ASSIGNED', 'AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER']);
/** FR-TRK-005: after this, the customer sees "Location updating…". */
const STALE_MS = 60_000;

/** Customer order tracking: REST snapshot and poll fallback (API-TRK-001/002, FR-CORD-004…006). */
export class OrderTrackingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly presence: PresenceStore,
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  private async owned(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: {
        delivery: {
          include: {
            partner: {
              select: {
                id: true,
                user: { select: { fullName: true } },
                vehicles: { where: { isActive: true, deletedAt: null }, select: { type: true } },
                stats: { select: { ratingAvgBps: true, ratingCount: true } },
              },
            },
          },
        },
        branch: { select: { name: true, restaurant: { select: { brandName: true } } } },
      },
    });
    // Someone else's order looks exactly like a missing one.
    if (!order) throw new AppError('NOT_FOUND', { message: 'Order not found.' });
    return order;
  }

  private async location(delivery: { status: string; partnerId: string | null } | null) {
    if (!delivery?.partnerId || !SHARED.has(delivery.status)) return null;
    const now = this.clock.now().getTime();
    const p = await this.presence.get(delivery.partnerId).catch(() => null);
    let fix = p && p.at ? { lat: p.lat, lng: p.lng, accuracyM: p.accuracyM, at: p.at } : null;
    if (!fix) {
      // Redis lost it: fall back to the last copy written to the database.
      const [row] = await this.prisma.$queryRaw<{ lat: number; lng: number; at: Date }[]>`
        SELECT ST_Y(last_location::geometry) AS lat, ST_X(last_location::geometry) AS lng, last_location_at AS at
        FROM delivery_partners WHERE id = ${delivery.partnerId}::uuid AND last_location IS NOT NULL`;
      if (row) fix = { lat: row.lat, lng: row.lng, accuracyM: 0, at: row.at.getTime() };
    }
    if (!fix) return null;
    const ageSeconds = Math.max(0, Math.round((now - fix.at) / 1000));
    return {
      lat: fix.lat,
      lng: fix.lng,
      accuracyM: fix.accuracyM || null,
      recordedAt: new Date(fix.at),
      ageSeconds,
      stale: now - fix.at > STALE_MS,
    };
  }

  /** API-TRK-001. */
  async snapshot(userId: string, orderId: string) {
    const order = await this.owned(userId, orderId);
    const [points] = await this.prisma.$queryRaw<
      { blat: number; blng: number; dlat: number | null; dlng: number | null }[]
    >`
      SELECT ST_Y(b.location::geometry) AS blat, ST_X(b.location::geometry) AS blng,
        ST_Y(a.location::geometry) AS dlat, ST_X(a.location::geometry) AS dlng
      FROM branches b LEFT JOIN order_addresses a ON a.order_id = ${order.id}::uuid
      WHERE b.id = ${order.branchId}::uuid`;
    const d = order.delivery;
    const partner = d?.partner && SHARED.has(d.status) ? d.partner : null;
    const live = Boolean(partner);
    return {
      orderId: order.id,
      number: order.number,
      status: order.status,
      eta:
        order.etaMinAt && order.etaMaxAt ? { minAt: order.etaMinAt, maxAt: order.etaMaxAt } : null,
      restaurant: {
        name: `${order.branch.restaurant.brandName}, ${order.branch.name}`,
        lat: points?.blat ?? null,
        lng: points?.blng ?? null,
      },
      destination: points?.dlat != null ? { lat: points.dlat, lng: points.dlng } : null,
      delivery: d
        ? {
            status: d.status,
            assignedAt: d.assignedAt,
            arrivedRestaurantAt: d.arrivedRestaurantAt,
            pickedUpAt: d.pickedUpAt,
            arrivedCustomerAt: d.arrivedCustomerAt,
            deliveredAt: d.deliveredAt,
          }
        : null,
      // First name, vehicle and rating only (BR-DEL-012; masked calling is CORE).
      partner: partner
        ? {
            firstName: partner.user.fullName.split(/\s+/)[0],
            vehicleType: partner.vehicles[0]?.type ?? null,
            rating: partner.stats?.ratingAvgBps ? partner.stats.ratingAvgBps / 100 : null,
          }
        : null,
      location: await this.location(d),
      route: null, // FR-CORD-005: no routing provider yet (EstimatedRouting has no geometry).
      // FR-CORD-006 / BR-DEL-009: shown once a partner is on the way, for OTP handovers.
      deliveryCode:
        live && !order.contactless && order.deliveryOtpHash
          ? deliveryCode(this.secret, order.id)
          : null,
      live,
    };
  }

  /** API-TRK-002: the latest partner location only (poll fallback). */
  async latest(userId: string, orderId: string) {
    const order = await this.owned(userId, orderId);
    return {
      status: order.delivery?.status ?? null,
      location: await this.location(order.delivery),
    };
  }
}
