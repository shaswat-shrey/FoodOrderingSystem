import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { CLIENT_APPS, SOCKET_NAMESPACES, type ClientApp } from '@fos/shared';
import type { Logger } from '../logger';
import type { RateLimiter } from '../rate-limit';
import { attachConnectionLogging } from '../redis';

/** What the gateway needs from the auth module (kept as an interface to avoid a platform → module import). */
export interface SocketAuth {
  /**
   * Verifies an access token for `app` and the live session behind it
   * (FR-AUTH-021). Resolves to the identity, or rejects with a code.
   */
  authenticate(
    token: string,
    app: ClientApp,
  ): Promise<{ userId: string; sessionId: string; expiresAt: Date }>;
}

/** Who is on a socket, as rooms and handlers see it. */
export interface SocketSubject {
  userId: string;
  sessionId: string;
  app: ClientApp;
}

/** Server-side room policy (SRS §13.3); kept as an interface so the platform doesn't import modules. */
export interface RoomAuthorizer {
  /** Rooms joined on connect besides `user:` and `session:` (partner, branch status). */
  autoRooms(subject: SocketSubject): Promise<string[]>;
  /** The room for a subscription, or null when forbidden or missing (same answer, FR-RT-010). */
  authorize(subject: SocketSubject, request: { type: string; id?: string }): Promise<string | null>;
}

/** Delivery-namespace client events (EVT-C-004…006). */
export interface PartnerSocketHandlers {
  location(userId: string, fix: LocationFix): Promise<void>;
  heartbeat(userId: string, payload: { state?: string; appVisible?: boolean }): Promise<void>;
  offerAck(userId: string, offerId: string): Promise<void>;
}

const subscription = z
  .object({ type: z.string().min(1).max(30), id: z.string().uuid().optional() })
  .strict();
const locationFix = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(5_000),
    heading: z.number().min(0).max(360).optional(),
    speed: z.number().min(0).max(400).optional(),
    recordedAt: z.string().datetime().optional(),
    batteryPct: z.number().min(0).max(100).optional(),
    buffered: z.boolean().optional(),
  })
  .strict();
export type LocationFix = z.infer<typeof locationFix>;

/** Events pushed to clients through Redis so every API instance emits to its own sockets. */
export interface RealtimeMessage {
  namespace: string;
  rooms: string[];
  event: string;
  envelope: unknown;
}

/** Rejection with a client-visible code (sent as `connect_error.data`). */
export class SocketAuthError extends Error {
  readonly data: { code: string; message: string };
  constructor(code: string, message: string) {
    super(code);
    this.data = { code, message };
  }
}

export interface SocketServerOptions {
  corsOrigins: string[];
  logger: Logger;
  auth: SocketAuth;
  limiter: RateLimiter;
  /** Redis connection for the multi-instance adapter and the control channel. */
  redis?: Redis;
  controlChannel: string;
  /** Grace after token expiry before the socket is dropped (FR-RT-003). */
  expiryGraceMs?: number;
  rooms?: RoomAuthorizer;
  partner?: PartnerSocketHandlers;
  /** Channel carrying {@link RealtimeMessage}s (published by the worker's outbox consumers). */
  eventsChannel?: string;
  /** FR-RT-007: sockets per session. */
  maxSocketsPerSession?: number;
}

interface SocketData extends SocketSubject {
  expiryTimer?: NodeJS.Timeout;
  counters?: Map<string, { windowStart: number; count: number }>;
}

/** FR-RT-014: per-socket windows (kept on the socket; dropped events are only counted). */
function allow(data: SocketData, name: string, limit: number, windowMs: number): boolean {
  data.counters ??= new Map();
  const now = Date.now();
  const c = data.counters.get(name);
  if (!c || now - c.windowStart >= windowMs) {
    data.counters.set(name, { windowStart: now, count: 1 });
    return true;
  }
  c.count += 1;
  return c.count <= limit;
}

type Ack = (r: { ok: boolean; code?: string; room?: string }) => void;
const ackOf = (fn: unknown): Ack => (typeof fn === 'function' ? (fn as Ack) : () => undefined);

/**
 * The client's address as Express sees it with `trust proxy` = 1 (platform/http/app.ts):
 * the last X-Forwarded-For hop, added by our reverse proxy. Without this every socket
 * behind Nginx (or the dev/preview proxy) shares the proxy's address, and the per-IP
 * connection limit (FR-RT-007) throttles all users together.
 */
export function handshakeIp(socket: Pick<Socket, 'handshake'>): string {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const last = header?.split(',').at(-1)?.trim();
  return last || socket.handshake.address || 'unknown';
}

/**
 * Socket.IO gateway (SRS §13, SYSTEM-ARCHITECTURE §8). One namespace per app;
 * handshake authentication mirrors REST; revocations broadcast on the control
 * channel disconnect the affected sockets on every instance (FR-RT-004).
 * Clients subscribe to resources and the server picks the room (§13.3); pushed
 * events arrive on the events channel and are emitted to this instance's sockets.
 */
export function createSocketServer(httpServer: HttpServer, options: SocketServerOptions): Server {
  const graceMs = options.expiryGraceMs ?? 60_000;
  const io = new Server(httpServer, {
    cors: { origin: options.corsOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    serveClient: false,
  });

  if (options.redis) {
    const subscriber = options.redis.duplicate();
    attachConnectionLogging(subscriber, 'socket-adapter-sub', options.logger);
    io.adapter(createAdapter(options.redis, subscriber));
  }

  const scheduleExpiry = (socket: Socket, expiresAt: Date) => {
    const data = socket.data as SocketData;
    clearTimeout(data.expiryTimer);
    const delay = Math.max(0, expiresAt.getTime() + graceMs - Date.now());
    data.expiryTimer = setTimeout(() => {
      socket.emit('auth:expired', { code: 'TOKEN_EXPIRED' });
      socket.disconnect(true);
    }, delay);
    data.expiryTimer.unref();
  };

  for (const app of CLIENT_APPS) {
    const nsp = io.of(SOCKET_NAMESPACES[app]);

    nsp.use(async (socket, next) => {
      try {
        const ip = handshakeIp(socket);
        const limit = await options.limiter.hit(`rt:connect:${ip}`, 20, 60);
        if (!limit.allowed)
          throw new SocketAuthError('RATE_LIMITED', 'Too many connection attempts.');
        const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
        if (typeof token !== 'string' || token.length === 0) {
          throw new SocketAuthError('AUTH_TOKEN_MISSING', 'Sign in to receive live updates.');
        }
        const claims = await options.auth.authenticate(token, app).catch((error: unknown) => {
          throw error instanceof SocketAuthError
            ? error
            : new SocketAuthError('AUTH_TOKEN_INVALID', 'Sign in again to receive live updates.');
        });
        socket.data = {
          userId: claims.userId,
          sessionId: claims.sessionId,
          app,
        } satisfies SocketData;
        scheduleExpiry(socket, claims.expiresAt);
        next();
      } catch (error) {
        next(
          error instanceof SocketAuthError
            ? error
            : new SocketAuthError('AUTH_TOKEN_INVALID', 'Authentication failed.'),
        );
      }
    });

    nsp.on('connection', (socket) => {
      const data = socket.data as SocketData;
      const forbidden = () => {
        // FR-RT-010/026: repeated probing disconnects the socket and is logged.
        options.logger.warn(
          { userId: data.userId, app, ip: handshakeIp(socket) },
          'forbidden subscription',
        );
        if (!allow(data, 'forbidden', 20, 60_000)) socket.disconnect(true);
      };

      socket.on('subscribe', async (payload: unknown, ack: unknown) => {
        const reply = ackOf(ack);
        if (!allow(data, 'subscribe', 30, 60_000))
          return reply({ ok: false, code: 'RATE_LIMITED' });
        const parsed = subscription.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, code: 'VALIDATION_ERROR' });
        const request = {
          type: parsed.data.type,
          ...(parsed.data.id ? { id: parsed.data.id } : {}),
        };
        const room = await options.rooms?.authorize(data, request).catch(() => null);
        if (!room) {
          forbidden();
          return reply({ ok: false, code: 'FORBIDDEN' });
        }
        await socket.join(room);
        reply({ ok: true, room });
      });
      socket.on('unsubscribe', async (payload: unknown, ack: unknown) => {
        const reply = ackOf(ack);
        const parsed = subscription.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, code: 'VALIDATION_ERROR' });
        const request = {
          type: parsed.data.type,
          ...(parsed.data.id ? { id: parsed.data.id } : {}),
        };
        const room = await options.rooms?.authorize(data, request).catch(() => null);
        if (room) await socket.leave(room);
        reply({ ok: true });
      });

      if (app === 'DELIVERY' && options.partner) {
        const partner = options.partner;
        socket.on('partner:location', async (payload: unknown, ack: unknown) => {
          // FR-RT-014: ≤ 1 per 2 s; extra fixes are dropped silently.
          if (!allow(data, 'location', 1, 2_000))
            return ackOf(ack)({ ok: false, code: 'RATE_LIMITED' });
          const parsed = locationFix.safeParse(payload);
          if (!parsed.success) return ackOf(ack)({ ok: false, code: 'VALIDATION_ERROR' });
          await partner.location(data.userId, parsed.data).then(
            () => ackOf(ack)({ ok: true }),
            () => ackOf(ack)({ ok: false, code: 'REJECTED' }),
          );
        });
        socket.on('partner:heartbeat', async (payload: unknown, ack: unknown) => {
          if (!allow(data, 'other', 60, 60_000))
            return ackOf(ack)({ ok: false, code: 'RATE_LIMITED' });
          const p = (payload ?? {}) as { state?: unknown; appVisible?: unknown };
          await partner
            .heartbeat(data.userId, {
              ...(typeof p.state === 'string' ? { state: p.state } : {}),
              ...(typeof p.appVisible === 'boolean' ? { appVisible: p.appVisible } : {}),
            })
            .catch(() => undefined);
          ackOf(ack)({ ok: true });
        });
        socket.on('offer:ack', async (payload: unknown, ack: unknown) => {
          if (!allow(data, 'other', 60, 60_000))
            return ackOf(ack)({ ok: false, code: 'RATE_LIMITED' });
          const offerId = (payload as { offerId?: unknown } | undefined)?.offerId;
          if (typeof offerId !== 'string')
            return ackOf(ack)({ ok: false, code: 'VALIDATION_ERROR' });
          await partner.offerAck(data.userId, offerId).catch(() => undefined);
          ackOf(ack)({ ok: true });
        });
      }

      // FR-RT-003: the client sends its new access token after every refresh.
      socket.on(
        'auth:refresh',
        async (payload: unknown, ack?: (r: { ok: boolean; code?: string }) => void) => {
          try {
            const token = (payload as { token?: unknown } | undefined)?.token;
            if (typeof token !== 'string') throw new Error('missing token');
            const claims = await options.auth.authenticate(token, app);
            if (claims.userId !== data.userId || claims.sessionId !== data.sessionId)
              throw new Error('different session');
            scheduleExpiry(socket, claims.expiresAt);
            ack?.({ ok: true });
          } catch {
            ack?.({ ok: false, code: 'AUTH_TOKEN_INVALID' });
            socket.disconnect(true);
          }
        },
      );

      // Handlers are registered first so early client events are not lost.
      const setup = async () => {
        // FR-RT-005: personal room; the session room lets revocation target this device.
        await socket.join([`user:${data.userId}`, `session:${data.sessionId}`]);
        // FR-RT-007: at most N sockets per session (the newest wins a place only if there is room).
        const peers = await nsp
          .in(`session:${data.sessionId}`)
          .fetchSockets()
          .catch(() => []);
        if (peers.length > (options.maxSocketsPerSession ?? 5)) {
          socket.emit('error:limit', { code: 'TOO_MANY_CONNECTIONS' });
          socket.disconnect(true);
          return;
        }
        if (options.rooms) {
          const auto = await options.rooms.autoRooms(data).catch((error: unknown) => {
            options.logger.warn({ err: error }, 'auto rooms failed');
            return [];
          });
          if (auto.length) await socket.join(auto);
        }
      };
      void setup().catch((error: unknown) =>
        options.logger.warn({ err: error }, 'socket setup failed'),
      );

      socket.on('disconnect', () => clearTimeout(data.expiryTimer));
    });
  }

  // Unused default namespace.
  io.use((_socket, next) => next(new SocketAuthError('FORBIDDEN', 'Unknown namespace.')));

  if (options.redis) {
    const control = options.redis.duplicate();
    attachConnectionLogging(control, 'realtime-control', options.logger);
    void control.subscribe(options.controlChannel);
    control.on('message', (_channel: string, raw: string) =>
      handleControl(io, raw, options.logger),
    );
    io.engine.on('close', () => control.disconnect());
  }

  if (options.redis && options.eventsChannel) {
    const events = options.redis.duplicate();
    attachConnectionLogging(events, 'realtime-events', options.logger);
    void events.subscribe(options.eventsChannel);
    events.on('message', (_channel: string, raw: string) => deliver(io, raw, options.logger));
    io.engine.on('close', () => events.disconnect());
  }

  options.logger.info(
    { namespaces: Object.values(SOCKET_NAMESPACES) },
    'socket gateway initialised',
  );
  return io;
}

/** Emits a pushed event to this instance's sockets in the given rooms (FR-RT-006). */
export function deliver(io: Server, raw: string, logger: Logger): void {
  try {
    const m = JSON.parse(raw) as RealtimeMessage;
    if (!m.rooms?.length) return;
    io.of(m.namespace).local.to(m.rooms).emit(m.event, m.envelope);
  } catch (error) {
    logger.warn({ err: error }, 'ignored malformed realtime event');
  }
}

/** Applies a control message on this instance (exported for tests and single-instance use). */
export function handleControl(io: Server, raw: string, logger: Logger): void {
  try {
    const message = JSON.parse(raw) as {
      type?: string;
      sessionId?: string;
      namespace?: string;
      target?: string;
      room?: string;
    };
    // FR-RT-011: rooms follow authorization changes (assignment, release, removal).
    if (
      (message.type === 'rooms.join' || message.type === 'rooms.leave') &&
      message.namespace &&
      message.target &&
      message.room
    ) {
      const sockets = io.of(message.namespace).local.in(message.target);
      if (message.type === 'rooms.join') sockets.socketsJoin(message.room);
      else sockets.socketsLeave(message.room);
      return;
    }
    if (message.type === 'session.revoked' && typeof message.sessionId === 'string') {
      for (const app of CLIENT_APPS) {
        io.of(SOCKET_NAMESPACES[app])
          .local.in(`session:${message.sessionId}`)
          .disconnectSockets(true);
      }
    }
  } catch (error) {
    logger.warn({ err: error }, 'ignored malformed realtime control message');
  }
}
