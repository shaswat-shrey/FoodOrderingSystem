import type { Prisma, PrismaClient, SessionRevokeReason, UserStatus } from '@fos/db';
import type { ClientApp } from '@fos/shared';
import type { Redis } from 'ioredis';
import { uuidv7 } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { openWith, randomToken, sealWith, sha256 } from '../../platform/crypto';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import { softRedis } from '../../platform/redis';
import { AUTH_POLICY, SESSION_LIFETIME } from './policy';

type Db = PrismaClient | Prisma.TransactionClient;

export interface DeviceInfo {
  ip?: string | null;
  userAgent?: string | null;
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  absoluteExpiresAt: Date;
}

/** Live state checked on every authenticated request (FR-AUTH-021). */
export interface SessionState {
  sessionId: string;
  userId: string;
  app: ClientApp;
  active: boolean;
  userStatus: UserStatus;
  tokenVersion: number;
  permissionVersion: number;
  phoneVerified: boolean;
  lastActiveAt: string;
}

export type RotationResult =
  | {
      kind: 'rotated';
      sessionId: string;
      userId: string;
      refreshToken: string;
      absoluteExpiresAt: Date;
    }
  | { kind: 'race' }
  | { kind: 'reused'; sessionId: string; userId: string };

/** Domain for sealing a successor refresh token to the token it replaced. */
const SUCCESSOR_SEAL = 'refresh-successor';

/** Pub/sub channel every API instance listens on to drop sockets (FR-RT-004). */
export const REALTIME_CONTROL_CHANNEL = 'rt:control';

interface TokenRow {
  token_id: string;
  token_status: 'ACTIVE' | 'ROTATED' | 'REVOKED';
  rotated_at: Date | null;
  session_id: string;
  user_id: string;
  app: ClientApp;
  session_status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  idle_expires_at: Date;
  absolute_expires_at: Date;
}

/** Human-readable device label from a user agent, without a parsing dependency. */
export function deviceLabel(userAgent?: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /SamsungBrowser/.test(userAgent)
      ? 'Samsung Internet'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad|iOS/.test(userAgent)
      ? 'iOS'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  private cacheKey(sessionId: string): string {
    return `sess:${sessionId}`;
  }

  /** Creates a device session and its first refresh token (FR-AUTH-020). */
  async create(db: Db, userId: string, app: ClientApp, device: DeviceInfo): Promise<IssuedSession> {
    const now = this.clock.now();
    const lifetime = SESSION_LIFETIME[app];

    // BR-AUTH-005: revoke the least-recently-active sessions beyond the cap.
    const active = await db.userSession.findMany({
      where: { userId, app, status: 'ACTIVE' },
      orderBy: { lastActiveAt: 'asc' },
      select: { id: true },
    });
    const excess = active.length - (AUTH_POLICY.maxSessionsPerApp - 1);
    for (const s of active.slice(0, Math.max(0, excess))) {
      await this.revokeIn(db, s.id, 'SESSION_LIMIT');
    }

    const sessionId = uuidv7();
    const absoluteExpiresAt = new Date(now.getTime() + lifetime.absoluteSeconds * 1000);
    await db.userSession.create({
      data: {
        id: sessionId,
        userId,
        app,
        ip: device.ip ?? null,
        userAgent: device.userAgent?.slice(0, 512) ?? null,
        deviceLabel: deviceLabel(device.userAgent),
        lastActiveAt: now,
        idleExpiresAt: new Date(now.getTime() + lifetime.idleSeconds * 1000),
        absoluteExpiresAt,
        createdAt: now,
      },
    });
    const refreshToken = randomToken();
    await db.refreshToken.create({
      data: {
        sessionId,
        tokenHash: sha256(refreshToken),
        expiresAt: absoluteExpiresAt,
        issuedAt: now,
      },
    });
    return { sessionId, refreshToken, absoluteExpiresAt };
  }

  /**
   * Refresh-token rotation with reuse detection (FR-AUTH-022). Exactly one ACTIVE
   * token exists per session; a rotated token presented after the grace window
   * revokes the whole session (token family).
   */
  async rotate(rawToken: string, app: ClientApp): Promise<RotationResult> {
    const now = this.clock.now();
    const result = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<TokenRow[]>`
        SELECT rt.id AS token_id, rt.status AS token_status, rt.rotated_at,
               s.id AS session_id, s.user_id, s.app, s.status AS session_status,
               s.idle_expires_at, s.absolute_expires_at
        FROM refresh_tokens rt
        JOIN user_sessions s ON s.id = rt.session_id
        WHERE rt.token_hash = ${sha256(rawToken)}
        FOR UPDATE OF rt, s`;
      if (!row || row.app !== app) throw new AppError('AUTH_REFRESH_INVALID');
      if (row.session_status === 'REVOKED' || row.token_status === 'REVOKED')
        throw new AppError('AUTH_SESSION_REVOKED');

      if (row.token_status === 'ROTATED') {
        const sinceRotation = (now.getTime() - (row.rotated_at?.getTime() ?? 0)) / 1000;
        if (sinceRotation <= AUTH_POLICY.refreshGraceSeconds) {
          // BR-AUTH-007: a page load that started while the previous page's refresh was in
          // flight presents the old cookie (the aborted response never stored the new one).
          // Hand back the same successor, so both responses converge on one cookie.
          const successor = await this.unsealSuccessor(tx, rawToken, row.token_id);
          if (successor)
            return {
              kind: 'rotated',
              sessionId: row.session_id,
              userId: row.user_id,
              refreshToken: successor,
              absoluteExpiresAt: row.absolute_expires_at,
            } as const;
          return { kind: 'race' } as const;
        }
        await this.revokeIn(tx, row.session_id, 'REFRESH_REUSE');
        return { kind: 'reused', sessionId: row.session_id, userId: row.user_id } as const;
      }

      if (
        row.session_status === 'EXPIRED' ||
        row.absolute_expires_at <= now ||
        row.idle_expires_at <= now
      ) {
        await tx.userSession.update({
          where: { id: row.session_id },
          data: { status: 'EXPIRED', endedAt: now },
        });
        throw new AppError('AUTH_SESSION_EXPIRED');
      }

      // Retire the presented token first: the unique index allows only one ACTIVE token per session.
      await tx.refreshToken.update({
        where: { id: row.token_id },
        data: { status: 'ROTATED', rotatedAt: now },
      });
      const refreshToken = randomToken();
      await tx.refreshToken.create({
        data: {
          sessionId: row.session_id,
          tokenHash: sha256(refreshToken),
          parentId: row.token_id,
          expiresAt: row.absolute_expires_at,
          issuedAt: now,
        },
      });
      // Written before commit: a concurrent request for the old token waits on the row
      // lock above and finds the successor once this transaction commits.
      await this.sealSuccessor(rawToken, refreshToken);
      const idleSeconds = SESSION_LIFETIME[app].idleSeconds;
      await tx.userSession.update({
        where: { id: row.session_id },
        data: {
          lastActiveAt: now,
          idleExpiresAt: new Date(
            Math.min(now.getTime() + idleSeconds * 1000, row.absolute_expires_at.getTime()),
          ),
        },
      });
      return {
        kind: 'rotated',
        sessionId: row.session_id,
        userId: row.user_id,
        refreshToken,
        absoluteExpiresAt: row.absolute_expires_at,
      } as const;
    });
    if (result.kind !== 'race')
      await this.afterRevocationOrChange(result.sessionId, result.kind === 'reused');
    return result;
  }

  private successorKey(rawToken: string): string {
    return `rt:succ:${Buffer.from(sha256(`successor:${rawToken}`)).toString('hex')}`;
  }

  /**
   * Keeps the successor for the grace window, sealed with a key derived from the
   * token it replaces: only a holder of the old token can open it.
   */
  private async sealSuccessor(oldToken: string, successor: string): Promise<void> {
    // Without Redis a concurrent presentation is answered as a plain race (409).
    await softRedis(
      this.redis,
      (r) =>
        r.set(
          this.successorKey(oldToken),
          sealWith(oldToken, SUCCESSOR_SEAL, successor),
          'EX',
          AUTH_POLICY.refreshGraceSeconds + 5,
        ),
      null,
    );
  }

  /** The successor of a just-rotated token, when it is still the session's unused token. */
  private async unsealSuccessor(
    db: Db,
    oldToken: string,
    oldTokenId: string,
  ): Promise<string | null> {
    const sealed = await softRedis(this.redis, (r) => r.get(this.successorKey(oldToken)), null);
    if (!sealed) return null;
    const successor = openWith(oldToken, SUCCESSOR_SEAL, sealed);
    if (!successor) return null;
    const current = await db.refreshToken.findFirst({
      where: { tokenHash: sha256(successor), parentId: oldTokenId, status: 'ACTIVE' },
      select: { id: true },
    });
    return current ? successor : null;
  }

  /** Session state for request authentication, from a short-lived cache (FR-AUTH-021). */
  async state(sessionId: string): Promise<SessionState | null> {
    // NFR-AVAIL-004: without Redis every request reads the session from the database.
    const cached = await softRedis(this.redis, (r) => r.get(this.cacheKey(sessionId)), null);
    if (cached)
      return this.withExpiry(
        JSON.parse(cached) as SessionState & { idle: string; absolute: string },
      );
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        app: true,
        status: true,
        idleExpiresAt: true,
        absoluteExpiresAt: true,
        lastActiveAt: true,
        user: {
          select: {
            status: true,
            tokenVersion: true,
            permissionVersion: true,
            phoneVerifiedAt: true,
          },
        },
      },
    });
    if (!session) return null;
    const entry = {
      sessionId: session.id,
      userId: session.userId,
      app: session.app,
      active: session.status === 'ACTIVE',
      userStatus: session.user.status,
      tokenVersion: session.user.tokenVersion,
      permissionVersion: session.user.permissionVersion,
      phoneVerified: session.user.phoneVerifiedAt !== null,
      lastActiveAt: session.lastActiveAt.toISOString(),
      idle: session.idleExpiresAt.toISOString(),
      absolute: session.absoluteExpiresAt.toISOString(),
    };
    void softRedis(
      this.redis,
      (r) =>
        r.set(
          this.cacheKey(sessionId),
          JSON.stringify(entry),
          'EX',
          AUTH_POLICY.sessionCacheSeconds,
        ),
      null,
    );
    return this.withExpiry(entry);
  }

  private withExpiry(entry: SessionState & { idle: string; absolute: string }): SessionState {
    const now = this.clock.now().getTime();
    const expired = Date.parse(entry.idle) <= now || Date.parse(entry.absolute) <= now;
    const { idle: _idle, absolute: _absolute, ...state } = entry;
    return { ...state, active: state.active && !expired };
  }

  /** Records activity at most every 5 minutes per session (write coalescing). */
  async touch(state: SessionState): Promise<void> {
    const now = this.clock.now();
    if (now.getTime() - Date.parse(state.lastActiveAt) < AUTH_POLICY.touchIntervalSeconds * 1000)
      return;
    const idle = SESSION_LIFETIME[state.app].idleSeconds;
    await this.prisma.$executeRaw`
      UPDATE user_sessions
      SET last_active_at = ${now}, idle_expires_at = LEAST(${new Date(now.getTime() + idle * 1000)}, absolute_expires_at)
      WHERE id = ${state.sessionId}::uuid AND status = 'ACTIVE'`;
    await softRedis(this.redis, (r) => r.del(this.cacheKey(state.sessionId)), 0);
  }

  private async revokeIn(db: Db, sessionId: string, reason: SessionRevokeReason): Promise<void> {
    const now = this.clock.now();
    await db.userSession.updateMany({
      where: { id: sessionId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokeReason: reason, endedAt: now },
    });
    await db.refreshToken.updateMany({
      where: { sessionId, status: { in: ['ACTIVE', 'ROTATED'] } },
      data: { status: 'REVOKED' },
    });
    await db.pushSubscription.deleteMany({ where: { sessionId } });
  }

  async revoke(
    sessionId: string,
    reason: SessionRevokeReason,
    db: Db = this.prisma,
  ): Promise<void> {
    await this.revokeIn(db, sessionId, reason);
    await this.afterRevocationOrChange(sessionId, true);
  }

  /** Revokes every session of a user (optionally keeping one) and invalidates outstanding access tokens. */
  async revokeAll(
    userId: string,
    reason: SessionRevokeReason,
    keepSessionId?: string,
  ): Promise<string[]> {
    const sessions = await this.prisma.userSession.findMany({
      where: { userId, status: 'ACTIVE', ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
      select: { id: true },
    });
    await this.prisma.$transaction(async (tx) => {
      for (const s of sessions) await this.revokeIn(tx, s.id, reason);
      // FR-AUTH-006: bump token version so access tokens of revoked sessions die at once.
      if (!keepSessionId)
        await tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    });
    for (const s of sessions) await this.afterRevocationOrChange(s.id, true);
    if (keepSessionId) await this.invalidate(keepSessionId);
    return sessions.map((s) => s.id);
  }

  /** Drops the cached state of a session (e.g. after a user-level change). */
  async invalidate(sessionId: string): Promise<void> {
    await softRedis(this.redis, (r) => r.del(this.cacheKey(sessionId)), 0);
  }

  /** Invalidates every cached session of a user (status or version changes). */
  async invalidateUser(userId: string): Promise<void> {
    const sessions = await this.prisma.userSession.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { id: true },
    });
    await Promise.all(sessions.map((s) => this.invalidate(s.id)));
  }

  private async afterRevocationOrChange(sessionId: string, revoked: boolean): Promise<void> {
    await this.invalidate(sessionId);
    if (revoked) {
      const sent = await softRedis(
        this.redis,
        (r) =>
          r.publish(
            REALTIME_CONTROL_CHANNEL,
            JSON.stringify({ type: 'session.revoked', sessionId }),
          ),
        null,
      );
      // Sockets also re-check the session when their access token is refreshed (FR-RT-003).
      if (sent === null) this.logger.warn({ sessionId }, 'could not publish session revocation');
    }
  }

  async list(userId: string) {
    return this.prisma.userSession.findMany({
      where: { userId, status: 'ACTIVE', absoluteExpiresAt: { gt: this.clock.now() } },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        app: true,
        deviceLabel: true,
        ip: true,
        createdAt: true,
        lastActiveAt: true,
      },
    });
  }

  async markReauthenticated(sessionId: string): Promise<void> {
    await this.prisma.userSession.update({
      where: { id: sessionId },
      data: { reauthAt: this.clock.now() },
    });
  }

  /** BR-AUTH-017: sensitive operations need a password/OTP confirmation in the last 5 minutes. */
  async requireRecentReauth(sessionId: string): Promise<void> {
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { reauthAt: true },
    });
    const limit = this.clock.now().getTime() - AUTH_POLICY.reauthValiditySeconds * 1000;
    if (!session?.reauthAt || session.reauthAt.getTime() < limit)
      throw new AppError('AUTH_REAUTH_REQUIRED');
  }
}
