import type { OnlineSessionEndReason, PrismaClient } from '@fos/db';

import { uuidv7 } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import { raiseOpsAlert } from '../../platform/ops-alerts';
import type { ServiceabilityService } from '../catalog';
import type { SettingsService } from '../config';
import { haversineM } from '../geo';
import type { LedgerService } from '../ledger';
import { GUIDELINES_VERSION } from './onboarding.service';
import type { Presence, PresenceStore } from './presence';

export const ACTIVE_DELIVERY = [
  'ASSIGNED',
  'AT_RESTAURANT',
  'EN_ROUTE_TO_CUSTOMER',
  'AT_CUSTOMER',
] as const;
const SPOOF_KMH = 150; // BR-DEL-015

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
  recordedAt?: Date | undefined;
  heading?: number | undefined;
  speedKmh?: number | undefined;
}

/**
 * Partner availability and location (FR-DP-010…015, BR-DEL-001, 006, 010, 011, 015).
 * Redis holds the live copy (PresenceStore); `delivery_partners.availability_state`
 * and `last_location` are written on every transition.
 */
export class PartnerAvailabilityService {
  /** Set by dispatch: withdraw an open offer when a partner leaves (DELIVERY-ASSIGNMENT-ALGORITHM §8). */
  onLeave: ((partnerId: string) => Promise<void>) | null = null;
  /** Set by dispatch: a partner became idle (new candidate for waiting deliveries). */
  onIdle: ((partnerId: string) => Promise<void>) | null = null;
  /** EVT-DP-014: the server took the partner offline (auto-offline, cash cap, admin). */
  onOffline: ((partnerId: string, reason: string) => Promise<void>) | null = null;
  /** FR-TRK-006: an accepted fix, for live tracking (deliveryId when on a trip). */
  onLocation:
    | ((partnerId: string, deliveryId: string | null, fix: Fix & { at: number }) => Promise<void>)
    | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly presence: PresenceStore,
    private readonly serviceability: ServiceabilityService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async partnerFor(userId: string) {
    const p = await this.prisma.deliveryPartner.findUnique({
      where: { userId },
      include: { vehicles: { where: { isActive: true, deletedAt: null } }, documents: true },
    });
    if (!p || p.onboardingStatus !== 'APPROVED')
      throw new AppError('FORBIDDEN', { message: 'Finish your application first.' });
    return p;
  }

  cashInHand(partnerId: string) {
    return this.ledger.balance(this.prisma, {
      ownerType: 'PARTNER',
      ownerId: partnerId,
      type: 'PARTNER_CASH_IN_HAND',
    });
  }

  async activeDelivery(partnerId: string) {
    return this.prisma.delivery.findFirst({
      where: { partnerId, status: { in: [...ACTIVE_DELIVERY] } },
    });
  }

  /** FR-DP-010: every reason that keeps the partner offline right now. */
  async blockers(userId: string, fix?: Fix) {
    const p = await this.partnerFor(userId);
    const now = this.clock.now();
    const out: { code: string; message: string }[] = [];
    const add = (code: string, message: string) => out.push({ code, message });
    if (p.status !== 'ACTIVE')
      add('ACCOUNT_SUSPENDED', 'Your account is suspended. Contact support.');
    if (p.guidelinesVersionAck !== GUIDELINES_VERSION)
      add('GUIDELINES', 'Read and accept the delivery guidelines.');
    const vehicle = p.vehicles[0];
    if (!vehicle || vehicle.status !== 'VERIFIED') add('VEHICLE', 'Add a verified vehicle.');
    const expired = p.documents.filter(
      (d) => d.expiresOn && d.expiresOn < now && ['DL_FRONT', 'INSURANCE', 'RC'].includes(d.type),
    );
    if (expired.length) add('DOCUMENT_EXPIRED', `Renew: ${expired.map((d) => d.type).join(', ')}.`);
    if (fix) {
      const maxAge = (await this.settings.get('partner.locationMaxAgeSeconds')) * 1000;
      const maxAcc = await this.settings.get('partner.locationMaxAccuracyM');
      if (fix.recordedAt && now.getTime() - fix.recordedAt.getTime() > maxAge)
        add('LOCATION_STALE', 'Your location is out of date. Turn on GPS and try again.');
      if (fix.accuracyM > maxAcc)
        add(
          'LOCATION_INACCURATE',
          'Your location isn’t precise enough. Move to open sky and try again.',
        );
      const zone = await this.serviceability.zoneAt(fix);
      if (!zone || zone.status !== 'ACTIVE')
        add('OUTSIDE_ZONE', 'You’re outside our delivery zones.');
    }
    const cap = await this.settings.get('partner.cashCapAmount');
    if ((await this.cashInHand(p.id)) >= cap)
      add('CASH_CAP', 'Deposit the cash you hold before going online.');
    return { partner: p, blockers: out };
  }

  private async persist(
    partnerId: string,
    state: Presence['state'],
    fix?: { lat: number; lng: number } | null,
  ) {
    if (fix)
      await this.prisma.$executeRaw`
        UPDATE delivery_partners SET availability_state = ${state}::"PartnerAvailability",
          last_location = ST_SetSRID(ST_MakePoint(${fix.lng}, ${fix.lat}), 4326)::geography, last_location_at = ${this.clock.now()}, updated_at = now()
        WHERE id = ${partnerId}::uuid`;
    else
      await this.prisma.deliveryPartner.update({
        where: { id: partnerId },
        data: { availabilityState: state },
      });
  }

  /** API-DP-014 */
  async availability(userId: string) {
    const { partner, blockers } = await this.blockers(userId);
    const live = await this.presence.get(partner.id);
    const active = await this.activeDelivery(partner.id);
    return {
      state: live?.state ?? 'OFFLINE',
      offlineAfterCurrent: live?.offlineAfterCurrent ?? false,
      pausedUntil: live?.pausedUntil ? new Date(live.pausedUntil) : null,
      activeDeliveryId: active?.id ?? null,
      cashInHand: await this.cashInHand(partner.id),
      cashCap: await this.settings.get('partner.cashCapAmount'),
      blockers,
    };
  }

  /** API-DP-015 (FR-DP-010) */
  async goOnline(userId: string, fix: Fix) {
    const { partner, blockers } = await this.blockers(userId, fix);
    if (blockers.length)
      throw new AppError('PARTNER_CANNOT_GO_ONLINE', {
        message: blockers[0]!.message,
        details: blockers.map((b) => ({ path: 'reason', code: b.code, message: b.message })),
      });
    const zone = (await this.serviceability.zoneAt(fix))!;
    const live = await this.presence.get(partner.id);
    const active = await this.activeDelivery(partner.id);
    const state = active ? 'ON_DELIVERY' : 'ONLINE_IDLE';
    await this.presence.put(
      {
        partnerId: partner.id,
        state,
        zoneId: zone.id,
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: fix.accuracyM,
        at: (fix.recordedAt ?? this.clock.now()).getTime(),
        vehicle: partner.vehicles[0]!.type,
        offlineAfterCurrent: false,
        outsideSince: 0,
        pausedUntil: 0,
      },
      live?.zoneId,
    );
    await this.persist(partner.id, state, fix);
    const open = await this.prisma.partnerOnlineSession.findFirst({
      where: { partnerId: partner.id, endedAt: null },
    });
    if (!open)
      await this.prisma.partnerOnlineSession.create({
        data: { partnerId: partner.id, startedAt: this.clock.now() },
      });
    await this.prisma.partnerStats.upsert({
      where: { partnerId: partner.id },
      create: { partnerId: partner.id },
      update: { consecutiveMissedOffers: 0 },
    });
    if (state === 'ONLINE_IDLE') await this.onIdle?.(partner.id);
    return this.availability(userId);
  }

  /** Ends the online session and removes the partner from dispatch. */
  async setOffline(partnerId: string, reason: OnlineSessionEndReason) {
    const live = await this.presence.get(partnerId);
    if (live) await this.presence.put({ ...live, state: 'OFFLINE', offlineAfterCurrent: false });
    await this.persist(partnerId, 'OFFLINE');
    await this.prisma.partnerOnlineSession.updateMany({
      where: { partnerId, endedAt: null },
      data: { endedAt: this.clock.now(), endReason: reason },
    });
    await this.onLeave?.(partnerId);
    await this.onOffline?.(partnerId, reason);
  }

  /** API-DP-016 (FR-DP-011): with an active delivery the request waits until it's done. */
  async goOffline(userId: string) {
    const p = await this.partnerFor(userId);
    if (await this.activeDelivery(p.id)) {
      const live = await this.presence.get(p.id);
      if (live) await this.presence.put({ ...live, offlineAfterCurrent: true });
    } else await this.setOffline(p.id, 'MANUAL');
    return this.availability(userId);
  }

  /** API-DP-017/018 (CORE): a break of 15/30 minutes without offers. */
  async pause(userId: string, minutes: 15 | 30) {
    const p = await this.partnerFor(userId);
    const live = await this.presence.get(p.id);
    if (!live || live.state !== 'ONLINE_IDLE')
      throw new AppError('PARTNER_CANNOT_GO_ONLINE', {
        message: 'You can take a break only while online and free.',
      });
    await this.presence.put({
      ...live,
      state: 'PAUSED',
      pausedUntil: this.clock.now().getTime() + minutes * 60_000,
    });
    await this.persist(p.id, 'PAUSED');
    return this.availability(userId);
  }

  async resume(userId: string) {
    const p = await this.partnerFor(userId);
    const live = await this.presence.get(p.id);
    if (live?.state === 'PAUSED') {
      await this.presence.put({ ...live, state: 'ONLINE_IDLE', pausedUntil: 0 });
      await this.persist(p.id, 'ONLINE_IDLE');
      await this.onIdle?.(p.id);
    }
    return this.availability(userId);
  }

  /**
   * API-DP-020 (FR-TRK-001/008): batched fixes, oldest first. The newest one
   * moves the partner; all of them are kept for an active delivery's trail.
   */
  async ingest(userId: string, fixes: Fix[]) {
    const p = await this.partnerFor(userId);
    const live = await this.presence.get(p.id);
    if (!live || live.state === 'OFFLINE') return { accepted: 0, state: 'OFFLINE' as const };
    const now = this.clock.now();
    const sorted = [...fixes].sort(
      (a, b) => (a.recordedAt?.getTime() ?? 0) - (b.recordedAt?.getTime() ?? 0),
    );
    const latest = sorted.at(-1)!;
    const at = (latest.recordedAt ?? now).getTime();
    if (at < live.at) return { accepted: 0, state: live.state };
    // BR-DEL-015: implausible speed flags the partner for review (no automatic action in MVP).
    const seconds = (at - live.at) / 1000;
    if (seconds > 0 && (haversineM(live, latest) / seconds) * 3.6 > SPOOF_KMH)
      await raiseOpsAlert(this.prisma, {
        type: 'PARTNER_LOCATION_SUSPECT',
        severity: 'WARNING',
        refType: 'partner',
        refId: p.id,
        message: `Implied speed above ${SPOOF_KMH} km/h.`,
        dedupeKey: `spoof:${p.id}`,
      });
    const zone = await this.serviceability.zoneAt(latest);
    const inZone = zone?.status === 'ACTIVE';
    await this.presence.put(
      {
        ...live,
        lat: latest.lat,
        lng: latest.lng,
        accuracyM: latest.accuracyM,
        at,
        zoneId: inZone ? zone!.id : live.zoneId,
        outsideSince: inZone ? 0 : live.outsideSince || now.getTime(),
      },
      live.zoneId,
    );
    const active = await this.activeDelivery(p.id);
    if (active) {
      await this.prisma.$executeRaw`
        INSERT INTO delivery_locations (id, delivery_id, partner_id, location, accuracy_m, heading, speed_kmh, recorded_at)
        SELECT f.id, ${active.id}::uuid, ${p.id}::uuid, ST_SetSRID(ST_MakePoint(f.lng, f.lat), 4326)::geography, f.acc, f.heading, f.speed, f.at
        FROM jsonb_to_recordset(${JSON.stringify(
          sorted.map((f) => ({
            id: uuidv7(),
            lat: f.lat,
            lng: f.lng,
            acc: Math.round(f.accuracyM),
            heading: f.heading ?? null,
            speed: f.speedKmh ?? null,
            at: (f.recordedAt ?? now).toISOString(),
          })),
        )}::jsonb) AS f(id uuid, lat float8, lng float8, acc int, heading int, speed int, at timestamptz)`;
    }
    // The database copy follows at most once a minute (or on transitions).
    const last = await this.prisma.deliveryPartner.findUnique({
      where: { id: p.id },
      select: { lastLocationAt: true },
    });
    if (!last?.lastLocationAt || now.getTime() - last.lastLocationAt.getTime() > 60_000)
      await this.persist(p.id, live.state, latest);
    await this.onLocation?.(p.id, active?.id ?? null, { ...latest, at })?.catch(() => undefined);
    return { accepted: sorted.length, state: live.state };
  }

  /**
   * JOB-DP-001 (BR-DEL-006): silent idle partners and partners outside all
   * zones too long go offline; finished breaks resume.
   */
  async sweep(): Promise<{ offline: number; resumed: number }> {
    const now = this.clock.now().getTime();
    const inactiveMs = (await this.settings.get('partner.inactiveOfflineMinutes')) * 60_000;
    const outsideMs = (await this.settings.get('partner.outsideZoneMinutes')) * 60_000;
    let offline = 0;
    let resumed = 0;
    for (const id of await this.presence.online()) {
      const p = await this.presence.get(id);
      if (!p) continue;
      if (p.state === 'PAUSED' && p.pausedUntil && p.pausedUntil <= now) {
        await this.presence.put({ ...p, state: 'ONLINE_IDLE', pausedUntil: 0 });
        await this.persist(id, 'ONLINE_IDLE');
        resumed++;
        continue;
      }
      if (p.state !== 'ONLINE_IDLE') continue;
      if (now - p.at > inactiveMs) {
        await this.setOffline(id, 'AUTO_INACTIVE');
        offline++;
      } else if (p.outsideSince && now - p.outsideSince > outsideMs) {
        await this.setOffline(id, 'OUTSIDE_ZONE');
        offline++;
      }
    }
    if (offline || resumed) this.logger.info({ offline, resumed }, 'partner availability sweep');
    return { offline, resumed };
  }

  /** API-DP-019 (FR-DP-015): today's online time, deliveries and earnings. */
  async dashboard(userId: string) {
    const p = await this.partnerFor(userId);
    const now = this.clock.now();
    const start = new Date(now.getTime() - ((now.getTime() + 19_800_000) % 86_400_000));
    const sessions = await this.prisma.partnerOnlineSession.findMany({
      where: { partnerId: p.id, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
    });
    const onlineSeconds = Math.round(
      sessions.reduce(
        (s, x) =>
          s + ((x.endedAt ?? now).getTime() - Math.max(x.startedAt.getTime(), start.getTime())),
        0,
      ) / 1000,
    );
    const [deliveries, earned] = await Promise.all([
      this.prisma.delivery.count({
        where: { partnerId: p.id, status: 'DELIVERED', deliveredAt: { gte: start } },
      }),
      this.prisma.partnerEarning.aggregate({
        where: { partnerId: p.id, createdAt: { gte: start } },
        _sum: { totalAmount: true, tipAmount: true },
      }),
    ]);
    const active = await this.activeDelivery(p.id);
    return {
      onlineSeconds: Math.max(0, onlineSeconds),
      deliveries,
      earnings: earned._sum.totalAmount ?? 0,
      tips: earned._sum.tipAmount ?? 0,
      activeDeliveryId: active?.id ?? null,
      availability: await this.availability(userId),
    };
  }
}
