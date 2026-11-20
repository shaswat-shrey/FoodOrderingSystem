import { createServer } from 'node:http';
import { createPrismaClient, pingDatabase } from '@fos/db';
import { loadEnv } from './config/env';
import { createContainer } from './container';
import { createSocketAuth, REALTIME_CONTROL_CHANNEL } from './modules/auth';
import { QueueMessageDispatcher } from './modules/notifications';
import { systemClock } from './platform/clock';
import { createApp } from './platform/http/app';
import { createLogger } from './platform/logger';
import { mountRoutes } from './routes';
import { createSocketServer } from './platform/realtime/socket-server';
import { closeRedis, createRedisClients, pingRedis } from './platform/redis';

const SHUTDOWN_GRACE_MS = 25_000; // NFR-REL-007

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: 'api' });

  const prisma = createPrismaClient({
    url: env.DATABASE_URL,
    onQueryError: (message) => logger.error({ db: 'prisma' }, message.replace(/\s+/g, ' ').trim()),
  });
  const redis = createRedisClients(
    { core: env.REDIS_CORE_URL, cache: env.REDIS_CACHE_URL },
    logger,
  );
  const messages = new QueueMessageDispatcher(redis.core);
  const container = createContainer({ env, prisma, redis, logger, clock: systemClock, messages });
  const corsOrigins = Object.values(container.appOrigins);

  const app = createApp({
    logger,
    corsOrigins,
    readiness: {
      critical: { database: () => pingDatabase(prisma) },
      degradable: {
        redisCore: () => pingRedis(redis.core),
        redisCache: () => pingRedis(redis.cache),
      },
    },
    routes: (api) => mountRoutes(api, container),
  });

  const httpServer = createServer(app);
  const io = createSocketServer(httpServer, {
    corsOrigins,
    logger,
    redis: redis.core,
    auth: createSocketAuth(container.tokens, container.sessions),
    limiter: container.limiter,
    controlChannel: REALTIME_CONTROL_CHANNEL,
  });

  httpServer.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT, env: env.NODE_ENV }, 'api listening');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('forced exit after shutdown grace period');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    await new Promise<void>((resolve) => io.close(() => resolve())); // also closes httpServer
    await Promise.allSettled([messages.close(), prisma.$disconnect()]);
    await Promise.allSettled([closeRedis(redis.core), closeRedis(redis.cache)]);
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Logger may not exist yet (e.g. invalid env), so report on stderr.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
