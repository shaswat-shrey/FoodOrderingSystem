import { z } from 'zod';
import type { PrismaClient } from '@fos/db';
import type { Logger } from '../../platform/logger';

/**
 * Typed platform settings (FR-CFG-001). Each key has a schema and a default;
 * a stored value that fails its schema is ignored (and logged) so a bad edit
 * can never take the platform down. Values are cached in-process for 5 s,
 * which bounds how long a change takes to apply (FR-CFG-004).
 */
export const SETTING_DEFINITIONS = {
  /** BR-GEO-003: road distance ≈ straight line × factor when no routing provider. */
  'geo.roadFactor': { schema: z.number().min(1).max(3), default: 1.3 },
  /** IF-GEO-002: city-average motorbike speed for the travel-time fallback. */
  'geo.motorbikeKmph': { schema: z.number().min(5).max(60), default: 22 },
  /** FR-DISC-010: buffer and ± range for listing ETAs (minutes). */
  'discovery.etaBufferMinutes': { schema: z.number().int().min(0).max(30), default: 5 },
  'discovery.etaRangeMinutes': { schema: z.number().int().min(0).max(30), default: 5 },
  /** FR-DISC-011: weights of the "recommended" score (sum need not be 1). */
  'discovery.weights': {
    schema: z
      .object({
        rating: z.number().min(0),
        eta: z.number().min(0),
        popularity: z.number().min(0),
        offer: z.number().min(0),
        affinity: z.number().min(0),
      })
      .strict(),
    default: { rating: 0.35, eta: 0.25, popularity: 0.2, offer: 0.1, affinity: 0.1 },
  },
  /** BR-ADDR-001. */
  'address.maxPerUser': { schema: z.number().int().min(1).max(100), default: 20 },
  /** FR-ADDR-006: warn when the typed address geocodes this far from the pin. */
  'address.pinWarningMeters': { schema: z.number().int().min(50).max(5000), default: 500 },
  /** BR-PRICE-011: platform cap on an order's total (paise). */
  'order.maxOrderAmount': {
    schema: z.number().int().min(10_000).max(100_000_000),
    default: 1_000_000,
  },
  /** BR-ORDER-001: checkout session lifetime. */
  'checkout.sessionTtlSeconds': { schema: z.number().int().min(60).max(3600), default: 600 },
  /** BR-ORDER-003 / JOB-ORD-001 */
  'order.paymentTtlSeconds': { schema: z.number().int().min(60).max(3600), default: 900 },
  /** BR-ORDER-004 / JOB-ORD-002 */
  'order.acceptTimeoutSeconds': { schema: z.number().int().min(60).max(1800), default: 300 },
  'order.acceptReminderSeconds': { schema: z.number().int().min(30).max(1800), default: 120 },
  /** JOB-ORD-003: ACCEPTED → PREPARING automatically after this long (0 disables). */
  'order.autoPreparingSeconds': { schema: z.number().int().min(0).max(1800), default: 60 },
  /** BR-ORDER-011 */
  'cancellation.freeWindowAfterAcceptSeconds': {
    schema: z.number().int().min(0).max(600),
    default: 60,
  },
  'cancellation.acceptedFeeBps': { schema: z.number().int().min(0).max(10_000), default: 5000 },
  /** BR-REST-009: consecutive acceptance timeouts that auto-pause a branch, and for how long. */
  'restaurant.missedOrderPauseThreshold': {
    schema: z.number().int().min(1).max(20),
    default: 3,
  },
  'restaurant.missedOrderPauseMinutes': { schema: z.number().int().min(1).max(1440), default: 30 },
  /** BR-SUP-002 / FR-CORD-012: when issues and "not delivered" can be reported after delivery. */
  'support.issueWindowHours': { schema: z.number().int().min(1).max(720), default: 48 },
  'support.notDeliveredWindowMinutes': { schema: z.number().int().min(5).max(1440), default: 60 },
  /** BR-SUP-004 */
  'support.ticketsPerDay': { schema: z.number().int().min(1).max(100), default: 5 },
  /** BR-REFUND-006: auto-approved item refunds (to wallet). */
  'refund.autoApproveMaxAmount': {
    schema: z.number().int().min(0).max(1_000_000),
    default: 25_000,
  },
  'refund.autoApproveMaxPer90Days': { schema: z.number().int().min(0).max(50), default: 3 },
  'refund.autoApproveMinAccountDays': { schema: z.number().int().min(0).max(3650), default: 30 },
  /** FR-CSUP-006 (legal review, OD-15). */
  'legal.grievanceOfficer': {
    schema: z.object({
      name: z.string().max(120),
      designation: z.string().max(120),
      email: z.email(),
      phone: z.string().max(20),
      address: z.string().max(400),
      hours: z.string().max(120),
    }),
    default: {
      name: 'Grievance Officer',
      designation: 'Grievance Officer',
      email: 'grievance@example.com',
      phone: '+911800000000',
      address: 'To be confirmed by legal (OD-15)',
      hours: 'Mon–Sat, 10:00–18:00 IST',
    },
  },
  /** BR-PRICE-006: packaging fee caps (paise). */
  'packaging.maxPerItem': { schema: z.number().int().min(0).max(100_000), default: 1_000 },
  'packaging.maxPerOrder': { schema: z.number().int().min(0).max(100_000), default: 5_000 },
  /** BR-REST-002: "until I resume" pauses end after this long. */
  'restaurant.pauseMaxMinutes': { schema: z.number().int().min(15).max(1440), default: 240 },
  /** FR-REST-014: a manual close ends at the next day's first slot (false = until reopened). */
  'restaurant.manualCloseUntilNextDay': { schema: z.boolean(), default: true },
  /** BR-DEL-010: partner cash-in-hand cap (paise). */
  'partner.cashCapAmount': { schema: z.number().int().min(0).max(10_000_000), default: 300_000 },
  /** FR-DP-010 / BR-DEL-001: a usable location fix. */
  'partner.locationMaxAgeSeconds': { schema: z.number().int().min(10).max(600), default: 60 },
  'partner.locationMaxAccuracyM': { schema: z.number().int().min(10).max(1000), default: 100 },
  /** BR-DEL-006 auto-offline thresholds. */
  'partner.inactiveOfflineMinutes': { schema: z.number().int().min(1).max(60), default: 5 },
  'partner.outsideZoneMinutes': { schema: z.number().int().min(1).max(120), default: 10 },
  'partner.missedOffersOffline': { schema: z.number().int().min(1).max(20), default: 3 },
  /** BR-DEL-002/003 dispatch. */
  'dispatch.offerTimeoutSeconds': { schema: z.number().int().min(10).max(120), default: 30 },
  'dispatch.roundRadiiM': {
    schema: z.array(z.number().int().min(500).max(30_000)).min(1).max(5),
    default: [3_000, 5_000, 8_000],
  },
  'dispatch.offersPerRound': { schema: z.number().int().min(1).max(20), default: 5 },
  'dispatch.leadBufferMinutes': { schema: z.number().int().min(0).max(60), default: 5 },
  'dispatch.travelToRestaurantMinutes': { schema: z.number().int().min(1).max(60), default: 8 },
  'dispatch.noPartnerAfterReadyMinutes': { schema: z.number().int().min(5).max(120), default: 30 },
  'dispatch.noPartnerAfterAcceptMinutes': {
    schema: z.number().int().min(10).max(180),
    default: 45,
  },
  /** BR-DEL-017 */
  'dispatch.bicycleMaxPickupM': { schema: z.number().int().min(500).max(20_000), default: 3_000 },
  'dispatch.bicycleMaxDropM': { schema: z.number().int().min(500).max(20_000), default: 4_000 },
  /** BR-DEL-008 geofences and pickup code. */
  'delivery.restaurantGeofenceM': { schema: z.number().int().min(20).max(2_000), default: 200 },
  'delivery.customerGeofenceM': { schema: z.number().int().min(20).max(2_000), default: 150 },
  'pickup.verifyCode': { schema: z.boolean(), default: false },
  /** BR-PAY-002 */
  'cod.maxOrderAmount': { schema: z.number().int().min(0).max(10_000_000), default: 150_000 },
  /** BR-CART-002 */
  'cart.expiryDays': { schema: z.number().int().min(1).max(90), default: 7 },
  /** FR-SRCH-005. */
  'search.historyLimit': { schema: z.number().int().min(0).max(100), default: 20 },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFINITIONS)[K]['schema']>;

const TTL_MS = 5_000;

export class SettingsService {
  private cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value as SettingValue<K>;
    const definition = SETTING_DEFINITIONS[key];
    let value: unknown = definition.default;
    try {
      const row = await this.prisma.platformSetting.findUnique({ where: { key } });
      if (row) {
        const parsed = definition.schema.safeParse(row.value);
        if (parsed.success) value = parsed.data;
        else this.logger.warn({ key }, 'ignoring invalid platform setting; using default');
      }
    } catch (error) {
      // Settings must never break a request: fall back to the last value or default.
      this.logger.warn({ err: error, key }, 'platform settings unavailable; using fallback');
      if (cached) return cached.value as SettingValue<K>;
    }
    this.cache.set(key, { value, expiresAt: this.now() + TTL_MS });
    return value as SettingValue<K>;
  }
}
