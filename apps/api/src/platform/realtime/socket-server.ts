import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
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
}

interface SocketData {
  userId: string;
  sessionId: string;
  app: ClientApp;
  expiryTimer?: NodeJS.Timeout;
}

/**
 * Socket.IO gateway (SRS §13, SYSTEM-ARCHITECTURE §8). One namespace per app;
 * handshake authentication mirrors REST; revocations broadcast on the control
 * channel disconnect the affected sockets on every instance (FR-RT-004).
 * Resource rooms (orders, branches, deliveries) arrive with Phase 10.
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
        const ip = socket.handshake.address || 'unknown';
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
      // FR-RT-005: personal room; the session room lets revocation target this device.
      void socket.join([`user:${data.userId}`, `session:${data.sessionId}`]);

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

  options.logger.info(
    { namespaces: Object.values(SOCKET_NAMESPACES) },
    'socket gateway initialised',
  );
  return io;
}

/** Applies a control message on this instance (exported for tests and single-instance use). */
export function handleControl(io: Server, raw: string, logger: Logger): void {
  try {
    const message = JSON.parse(raw) as { type?: string; sessionId?: string };
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
