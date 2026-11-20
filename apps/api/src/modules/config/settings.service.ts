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
