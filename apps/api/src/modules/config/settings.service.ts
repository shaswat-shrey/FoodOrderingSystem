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
  'geo.roadFactor': {
    schema: z.number().min(1).max(3),
    default: 1.3,
    description:
      'Road distance ≈ straight line × this factor when no routing provider is available.',
  },
  /** IF-GEO-002: city-average motorbike speed for the travel-time fallback. */
  'geo.motorbikeKmph': {
    schema: z.number().min(5).max(60),
    default: 22,
    description: 'City-average motorbike speed for the travel-time fallback (km/h).',
  },
  /** FR-DISC-010: buffer and ± range for listing ETAs (minutes). */
  'discovery.etaBufferMinutes': {
    schema: z.number().int().min(0).max(30),
    default: 5,
    description: 'Minutes added to listing ETAs as a buffer.',
  },
  'discovery.etaRangeMinutes': {
    schema: z.number().int().min(0).max(30),
    default: 5,
    description: '± minutes around the listing ETA.',
  },
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
    description: 'Weights of the "recommended" listing score.',
  },
  /** BR-ADDR-001. */
  'address.maxPerUser': {
    schema: z.number().int().min(1).max(100),
    default: 20,
    description: 'Saved addresses allowed per customer.',
  },
  /** FR-ADDR-006: warn when the typed address geocodes this far from the pin. */
  'address.pinWarningMeters': {
    schema: z.number().int().min(50).max(5000),
    default: 500,
    description: 'Warn when the typed address geocodes this far from the pin (metres).',
  },
  /** BR-PRICE-011: platform cap on an order's total (paise). */
  'order.maxOrderAmount': {
    schema: z.number().int().min(10_000).max(100_000_000),
    default: 1_000_000,
    description: 'Platform cap on an order total (paise).',
    critical: true,
  },
  /** BR-ORDER-001: checkout session lifetime. */
  'checkout.sessionTtlSeconds': {
    schema: z.number().int().min(60).max(3600),
    default: 600,
    description: 'Checkout session lifetime (seconds).',
  },
  /** BR-ORDER-003 / JOB-ORD-001 */
  'order.paymentTtlSeconds': {
    schema: z.number().int().min(60).max(3600),
    default: 900,
    description: 'Time to complete an online payment before the order fails (seconds).',
  },
  /** BR-ORDER-004 / JOB-ORD-002 */
  'order.acceptTimeoutSeconds': {
    schema: z.number().int().min(60).max(1800),
    default: 300,
    description: 'Time a restaurant has to accept an order (seconds).',
  },
  'order.acceptReminderSeconds': {
    schema: z.number().int().min(30).max(1800),
    default: 120,
    description: 'When the restaurant is reminded about an unaccepted order (seconds).',
  },
  /** JOB-ORD-003: ACCEPTED → PREPARING automatically after this long (0 disables). */
  'order.autoPreparingSeconds': {
    schema: z.number().int().min(0).max(1800),
    default: 60,
    description: 'Accepted orders move to preparing after this long (0 disables).',
  },
  /** BR-ORDER-011 */
  'cancellation.freeWindowAfterAcceptSeconds': {
    schema: z.number().int().min(0).max(600),
    default: 60,
    description: 'Free customer cancellation window after acceptance (seconds).',
  },
  'cancellation.acceptedFeeBps': {
    schema: z.number().int().min(0).max(10_000),
    default: 5000,
    description: 'Cancellation fee after the free window (basis points of the order).',
    critical: true,
  },
  /** BR-REST-009: consecutive acceptance timeouts that auto-pause a branch, and for how long. */
  'restaurant.missedOrderPauseThreshold': {
    schema: z.number().int().min(1).max(20),
    default: 3,
    description: 'Consecutive acceptance timeouts that auto-pause a branch.',
  },
  'restaurant.missedOrderPauseMinutes': {
    schema: z.number().int().min(1).max(1440),
    default: 30,
    description: 'How long an auto-pause lasts (minutes).',
  },
  /** BR-SUP-002 / FR-CORD-012: when issues and "not delivered" can be reported after delivery. */
  'support.issueWindowHours': {
    schema: z.number().int().min(1).max(720),
    default: 48,
    description: 'How long after delivery issues can be reported (hours).',
  },
  'support.notDeliveredWindowMinutes': {
    schema: z.number().int().min(5).max(1440),
    default: 60,
    description: 'How long after delivery a not-delivered report is accepted (minutes).',
  },
  /** FR-ADMIN-051 / FR-REFUND-008: refunds a support agent may issue per order without approval (paise). */
  'support.refundLimit': {
    schema: z.number().int().min(0).max(10_000_000),
    default: 50_000,
    description: 'Refund a support agent may issue per order without approval (paise).',
    critical: true,
  },
  /** BR-SUP-004 */
  'support.ticketsPerDay': {
    schema: z.number().int().min(1).max(100),
    default: 5,
    description: 'Support tickets a customer may open per day.',
  },
  /** BR-REFUND-006: auto-approved item refunds (to wallet). */
  'refund.autoApproveMaxAmount': {
    schema: z.number().int().min(0).max(1_000_000),
    default: 25_000,
    description: 'Item refunds up to this amount are auto-approved to the wallet (paise).',
    critical: true,
  },
  'refund.autoApproveMaxPer90Days': {
    schema: z.number().int().min(0).max(50),
    default: 3,
    description: 'Auto-approved refunds allowed per customer in 90 days.',
    critical: true,
  },
  'refund.autoApproveMinAccountDays': {
    schema: z.number().int().min(0).max(3650),
    default: 30,
    description: 'Minimum account age for auto-approved refunds (days).',
    critical: true,
  },
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
    description: 'Grievance officer contact card shown to customers.',
    critical: true,
  },
  /** BR-PRICE-006: packaging fee caps (paise). */
  'packaging.maxPerItem': {
    schema: z.number().int().min(0).max(100_000),
    default: 1_000,
    description: 'Packaging fee cap per item (paise).',
    critical: true,
  },
  'packaging.maxPerOrder': {
    schema: z.number().int().min(0).max(100_000),
    default: 5_000,
    description: 'Packaging fee cap per order (paise).',
    critical: true,
  },
  /** BR-REST-002: "until I resume" pauses end after this long. */
  'restaurant.pauseMaxMinutes': {
    schema: z.number().int().min(15).max(1440),
    default: 240,
    description: 'Open-ended pauses end after this long (minutes).',
  },
  /** FR-REST-014: a manual close ends at the next day's first slot (false = until reopened). */
  'restaurant.manualCloseUntilNextDay': {
    schema: z.boolean(),
    default: true,
    description: 'A manual close ends at the next day’s first slot (false = until reopened).',
  },
  /** BR-DEL-010: partner cash-in-hand cap (paise). */
  'partner.cashCapAmount': {
    schema: z.number().int().min(0).max(10_000_000),
    default: 300_000,
    description: 'Partner cash-in-hand cap (paise).',
    critical: true,
  },
  /** BR-REVIEW-001/003/004/005. */
  'review.windowDays': {
    schema: z.number().int().min(1).max(60),
    default: 7,
    description: 'Days after delivery a review can be written.',
  },
  'review.editHours': {
    schema: z.number().int().min(0).max(720),
    default: 48,
    description: 'Hours a review stays editable.',
  },
  'review.responseEditHours': {
    schema: z.number().int().min(0).max(720),
    default: 24,
    description: 'Hours a restaurant response stays editable.',
  },
  'review.reportsToHide': {
    schema: z.number().int().min(1).max(50),
    default: 3,
    description: 'Independent reports that hide a review until moderation.',
  },
  /** BR-EARN-005: smaller partner payouts roll over to the next week (paise). */
  'partner.minPayoutAmount': {
    schema: z.number().int().min(0).max(1_000_000),
    default: 10_000,
    description: 'Smaller partner payouts roll over to the next week (paise).',
    critical: true,
  },
  /** FR-DP-010 / BR-DEL-001: a usable location fix. */
  'partner.locationMaxAgeSeconds': {
    schema: z.number().int().min(10).max(600),
    default: 60,
    description: 'Oldest usable partner location fix (seconds).',
  },
  'partner.locationMaxAccuracyM': {
    schema: z.number().int().min(10).max(1000),
    default: 100,
    description: 'Worst usable partner location accuracy (metres).',
  },
  /** BR-DEL-006 auto-offline thresholds. */
  'partner.inactiveOfflineMinutes': {
    schema: z.number().int().min(1).max(60),
    default: 5,
    description: 'Partners without location updates go offline after this long (minutes).',
  },
  'partner.outsideZoneMinutes': {
    schema: z.number().int().min(1).max(120),
    default: 10,
    description: 'Partners outside their zone go offline after this long (minutes).',
  },
  'partner.missedOffersOffline': {
    schema: z.number().int().min(1).max(20),
    default: 3,
    description: 'Consecutive missed offers that take a partner offline.',
  },
  /** BR-DEL-002/003 dispatch. */
  'dispatch.offerTimeoutSeconds': {
    schema: z.number().int().min(10).max(120),
    default: 30,
    description: 'How long a partner has to accept an offer (seconds).',
  },
  'dispatch.roundRadiiM': {
    schema: z.array(z.number().int().min(500).max(30_000)).min(1).max(5),
    default: [3_000, 5_000, 8_000],
    description: 'Search radius of each dispatch round (metres).',
  },
  'dispatch.offersPerRound': {
    schema: z.number().int().min(1).max(20),
    default: 5,
    description: 'Partners offered per dispatch round.',
  },
  'dispatch.leadBufferMinutes': {
    schema: z.number().int().min(0).max(60),
    default: 5,
    description: 'Dispatch starts this long before the food is expected ready (minutes).',
  },
  'dispatch.travelToRestaurantMinutes': {
    schema: z.number().int().min(1).max(60),
    default: 8,
    description: 'Assumed partner travel time to the restaurant (minutes).',
  },
  'dispatch.noPartnerAfterReadyMinutes': {
    schema: z.number().int().min(5).max(120),
    default: 30,
    description: 'Escalate when no partner is found this long after ready (minutes).',
  },
  'dispatch.noPartnerAfterAcceptMinutes': {
    schema: z.number().int().min(10).max(180),
    default: 45,
    description: 'Escalate when no partner is found this long after acceptance (minutes).',
  },
  /** BR-DEL-017 */
  'dispatch.bicycleMaxPickupM': {
    schema: z.number().int().min(500).max(20_000),
    default: 3_000,
    description: 'Furthest pickup offered to bicycle partners (metres).',
  },
  'dispatch.bicycleMaxDropM': {
    schema: z.number().int().min(500).max(20_000),
    default: 4_000,
    description: 'Furthest drop offered to bicycle partners (metres).',
  },
  /** BR-DEL-008 geofences and pickup code. */
  'delivery.restaurantGeofenceM': {
    schema: z.number().int().min(20).max(2_000),
    default: 200,
    description: 'Restaurant arrival geofence (metres).',
  },
  'delivery.customerGeofenceM': {
    schema: z.number().int().min(20).max(2_000),
    default: 150,
    description: 'Customer arrival geofence (metres).',
  },
  'pickup.verifyCode': {
    schema: z.boolean(),
    default: false,
    description: 'Require the pickup code at handover.',
  },
  /** BR-PAY-002 */
  'cod.maxOrderAmount': {
    schema: z.number().int().min(0).max(10_000_000),
    default: 150_000,
    description: 'Largest order payable by cash on delivery (paise).',
    critical: true,
  },
  /** BR-CART-002 */
  'cart.expiryDays': {
    schema: z.number().int().min(1).max(90),
    default: 7,
    description: 'Inactive carts expire after this many days.',
  },
  /** FR-SRCH-005. */
  'search.historyLimit': {
    schema: z.number().int().min(0).max(100),
    default: 20,
    description: 'Recent searches kept per customer.',
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

/** One registry entry, uniformly typed (FR-ADMIN-100). */
export interface SettingDefinition {
  schema: z.ZodType;
  default: unknown;
  description: string;
  /** FR-ADMIN-100: only a super admin may change critical keys. */
  critical?: boolean;
}

export const settingDefinition = (key: SettingKey): SettingDefinition =>
  SETTING_DEFINITIONS[key] as SettingDefinition;

export const isSettingKey = (key: string): key is SettingKey =>
  Object.prototype.hasOwnProperty.call(SETTING_DEFINITIONS, key);
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

  /** Drops cached values after an admin change; other processes catch up within the TTL. */
  invalidate(key?: SettingKey): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }
}
