import type { Redis } from 'ioredis';

export type PresenceState = 'OFFLINE' | 'ONLINE_IDLE' | 'OFFERED' | 'ON_DELIVERY' | 'PAUSED';

export interface Presence {
  partnerId: string;
  state: PresenceState;
  zoneId: string | null;
  lat: number;
  lng: number;
  accuracyM: number;
  /** Fix time (ms since epoch). */
  at: number;
  vehicle: string;
  offlineAfterCurrent: boolean;
  /** When the partner was first seen outside all zones (ms), or 0. */
  outsideSince: number;
  /** Paused until (ms), or 0. */
  pausedUntil: number;
}

const key = (id: string) => `partner:${id}:presence`;
const geo = (zoneId: string) => `partners:zone:${zoneId}`;
const ONLINE_SET = 'partners:online';

/**
 * Live partner state and position (FR-DP-013, DELIVERY-ASSIGNMENT-ALGORITHM §4):
 * a hash per partner and a GEO set per zone that dispatch searches. The
 * database keeps the authoritative availability on every transition.
 */
export class PresenceStore {
  constructor(private readonly redis: Redis) {}

  async get(partnerId: string): Promise<Presence | null> {
    const h = await this.redis.hgetall(key(partnerId));
    if (!h.state) return null;
    return {
      partnerId,
      state: h.state as PresenceState,
      zoneId: h.zoneId || null,
      lat: Number(h.lat),
      lng: Number(h.lng),
      accuracyM: Number(h.acc),
      at: Number(h.at),
      vehicle: h.vehicle ?? '',
      offlineAfterCurrent: h.offlineAfter === '1',
      outsideSince: Number(h.outsideSince ?? 0),
      pausedUntil: Number(h.pausedUntil ?? 0),
    };
  }

  async put(p: Presence, previousZoneId?: string | null): Promise<void> {
    const multi = this.redis.multi().hset(key(p.partnerId), {
      state: p.state,
      zoneId: p.zoneId ?? '',
      lat: p.lat,
      lng: p.lng,
      acc: p.accuracyM,
      at: p.at,
      vehicle: p.vehicle,
      offlineAfter: p.offlineAfterCurrent ? '1' : '0',
      outsideSince: p.outsideSince,
      pausedUntil: p.pausedUntil,
    });
    if (previousZoneId && previousZoneId !== p.zoneId) multi.zrem(geo(previousZoneId), p.partnerId);
    if (p.state === 'OFFLINE') {
      if (p.zoneId) multi.zrem(geo(p.zoneId), p.partnerId);
      multi.srem(ONLINE_SET, p.partnerId);
    } else {
      if (p.zoneId) multi.geoadd(geo(p.zoneId), p.lng, p.lat, p.partnerId);
      multi.sadd(ONLINE_SET, p.partnerId);
    }
    await multi.exec();
  }

  async setState(partnerId: string, state: PresenceState): Promise<void> {
    const p = await this.get(partnerId);
    if (p) await this.put({ ...p, state });
  }

  /** Partners within `radiusM` of a point in a zone, nearest first, with distance in metres. */
  async near(zoneId: string, point: { lat: number; lng: number }, radiusM: number, count = 50) {
    const rows = (await this.redis.geosearch(
      geo(zoneId),
      'FROMLONLAT',
      point.lng,
      point.lat,
      'BYRADIUS',
      radiusM,
      'm',
      'ASC',
      'COUNT',
      count,
      'WITHDIST',
    )) as [string, string][];
    return rows.map(([partnerId, dist]) => ({ partnerId, distanceM: Math.round(Number(dist)) }));
  }

  async online(): Promise<string[]> {
    return this.redis.smembers(ONLINE_SET);
  }

  /** At most one open offer per partner (DELIVERY-ASSIGNMENT-ALGORITHM §4). */
  async claimOfferSlot(partnerId: string, ttlSeconds: number): Promise<boolean> {
    return (
      (await this.redis.set(`offer-lock:partner:${partnerId}`, '1', 'EX', ttlSeconds, 'NX')) ===
      'OK'
    );
  }

  async releaseOfferSlot(partnerId: string): Promise<void> {
    await this.redis.del(`offer-lock:partner:${partnerId}`);
  }
}
