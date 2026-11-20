import { closeRedis, connectRedis, createLogger, pingRedis } from '@fos/api/platform';
import { loadWorkerEnv } from './env';
import { createHealthServer } from './health-server';
import { registrations, startWorkers } from './processors';

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: 'worker' });
  // The worker only needs the core (queue) Redis.
  const core = connectRedis(env.REDIS_CORE_URL, 'core', logger);

  const workers = startWorkers(registrations, core, logger);
  logger.info({ processors: registrations.map((r) => r.queue) }, `worker started with ${workers.length} processors`);

  const health = createHealthServer({ critical: { redisCore: () => pingRedis(core) }, degradable: {} }, logger);
  health.listen(env.WORKER_HEALTH_PORT, () => logger.info({ port: env.WORKER_HEALTH_PORT }, 'worker health listening'));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    // Worker.close() waits for active jobs to finish (NFR-REL-007).
    await Promise.allSettled(workers.map((w) => w.close()));
    health.close();
    await closeRedis(core);
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
