import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@fos/db';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import { haversineM, isInIndia } from './distance';
import type { GeoAddress, GeocodingProvider, LatLng, PlaceSuggestion } from './types';

const CACHE_TTL_MS = 30 * 86_400_000; // IF-GEO-006 / FR-LOC-002: 30 days

/** 4 decimal places ≈ 11 m, the reverse-geocode cache cell (FR-LOC-002). */
const cell = (n: number) => n.toFixed(4);

/**
 * Geocoding facade (FR-LOC-002/003, FR-ADDR-006): validates coordinates,
 * caches provider answers in `geocode_cache`, and turns provider failures
 * into GEO_PROVIDER_UNAVAILABLE so callers can take the degraded path.
 */
export class GeoService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: GeocodingProvider,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  assertInIndia(point: LatLng, path = 'location'): void {
    if (!isInIndia(point)) {
      throw new AppError('ADDRESS_INVALID', {
        message: 'This location is outside India. Drop the pin on your delivery location.',
        details: [{ path, code: 'OUTSIDE_INDIA', message: 'Location must be in India' }],
      });
    }
  }

  async autocomplete(
    query: string,
    bias: LatLng | null,
    sessionToken?: string,
  ): Promise<PlaceSuggestion[]> {
    return this.call('autocomplete', () => this.provider.autocomplete(query, bias, sessionToken));
  }

  async placeDetails(placeId: string): Promise<GeoAddress> {
    const result = await this.cached(`place:${this.provider.name}:${placeId.slice(0, 150)}`, () =>
      this.call('placeDetails', () => this.provider.placeDetails(placeId)),
    );
    if (!result) throw new AppError('NOT_FOUND', { message: "We couldn't find that place." });
    return result;
  }

  /** Never throws for provider trouble: returns null so the UI can show "Pin location" (degraded). */
  async reverse(point: LatLng): Promise<{ address: GeoAddress | null; degraded: boolean }> {
    this.assertInIndia(point);
    try {
      const address = await this.cached(
        `rev:${this.provider.name}:${cell(point.lat)}:${cell(point.lng)}`,
        () => this.call('reverse', () => this.provider.reverse(point)),
      );
      // Cached by cell, but always echo the caller's exact pin (FR-LOC-004: pin is authoritative).
      return {
        address: address ? { ...address, lat: point.lat, lng: point.lng } : null,
        degraded: false,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'GEO_PROVIDER_UNAVAILABLE')
        return { address: null, degraded: true };
      throw error;
    }
  }

  /** FR-ADDR-006: forward-geocode typed text and report its distance from the chosen pin. */
  async geocode(
    address: { line1?: string; line2?: string; area: string; city: string; pincode?: string },
    pin: LatLng | undefined,
    warnBeyondM: number,
  ) {
    const text = [address.line2, address.area, address.city, address.pincode]
      .map((v) => (v ?? '').trim().toLowerCase())
      .join('|');
    // Hashed so long addresses fit the 200-character cache key.
    const key = `geo:${this.provider.name}:${createHash('sha256').update(text).digest('hex')}`;
    const result = await this.cached(key, () =>
      this.call('geocode', () => this.provider.geocode(address)),
    );
    const distanceFromPinM = result && pin ? Math.round(haversineM(result, pin)) : null;
    return {
      result,
      distanceFromPinM,
      pinWarning: distanceFromPinM !== null && distanceFromPinM > warnBeyondM,
    };
  }

  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.logger.warn(
        { err: error, provider: this.provider.name, operation },
        'geocoding provider failed',
      );
      throw new AppError('GEO_PROVIDER_UNAVAILABLE', { retryable: true, cause: error });
    }
  }

  private async cached(
    key: string,
    load: () => Promise<GeoAddress | null>,
  ): Promise<GeoAddress | null> {
    const hit = await this.prisma.geocodeCache.findUnique({ where: { key } }).catch(() => null);
    if (hit && hit.expiresAt > this.now()) return hit.result as unknown as GeoAddress | null;
    const value = await load();
    const expiresAt = new Date(this.now().getTime() + CACHE_TTL_MS);
    const result = (value ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue;
    await this.prisma.geocodeCache
      .upsert({
        where: { key },
        create: { key, provider: this.provider.name, result, expiresAt },
        update: { result, expiresAt },
      })
      .catch((error: unknown) => this.logger.warn({ err: error }, 'geocode cache write failed'));
    return value;
  }
}
