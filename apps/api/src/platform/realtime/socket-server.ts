import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { CLIENT_APPS, SOCKET_NAMESPACES } from '@fos/shared';
import type { Logger } from '../logger';
import { attachConnectionLogging } from '../redis';

export interface SocketServerOptions {
  corsOrigins: string[];
  logger: Logger;
  /** Redis connection used for the multi-instance adapter (pub + sub duplicate). */
  redis?: Redis;
}

/**
 * Socket.IO gateway (SRS §13, SYSTEM-ARCHITECTURE §8).
 *
 * Phase 2 state: the four app namespaces exist, but handshake authentication
 * arrives with the auth module in Phase 4. Until then every connection is
 * rejected — the gateway is deny-by-default rather than open (NFR-SEC-020).
 */
export function createSocketServer(httpServer: HttpServer, options: SocketServerOptions): Server {
  const io = new Server(httpServer, {
    cors: { origin: options.corsOrigins },
    transports: ['websocket', 'polling'],
    serveClient: false,
  });

  if (options.redis) {
    const subscriber = options.redis.duplicate();
    attachConnectionLogging(subscriber, 'socket-adapter-sub', options.logger);
    io.adapter(createAdapter(options.redis, subscriber));
  }

  for (const app of CLIENT_APPS) {
    io.of(SOCKET_NAMESPACES[app]).use((_socket, next) => {
      const error = new Error('AUTH_TOKEN_INVALID') as Error & { data?: unknown };
      error.data = {
        code: 'AUTH_TOKEN_INVALID',
        message: 'Real-time authentication is not available yet.',
      };
      next(error);
    });
  }
  // The default namespace is not used by any client.
  io.use((_socket, next) => next(new Error('FORBIDDEN')));

  options.logger.info(
    { namespaces: Object.values(SOCKET_NAMESPACES) },
    'socket gateway initialised',
  );
  return io;
}
