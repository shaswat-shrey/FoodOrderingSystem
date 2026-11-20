import { Queue } from 'bullmq';
import { createPrismaClient, pingDatabase } from '@fos/db';
import { AccountAnonymizer, AuditService, CartExpiry, LedgerService } from '@fos/api/jobs';
import { closeRedis, connectRedis, createLogger, pingRedis } from '@fos/api/platform';
import { loadWorkerEnv } from './env';
import { createHealthServer } from './health-server';
import { buildRegistrations, createMessageSink, SCHEDULES, startWorkers } from './processors';

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: 'worker' });
  // The worker only needs the core (queue) Redis.
  const core = connectRedis(env.REDIS_CORE_URL, 'core', logger);

  const prisma = createPrismaClient({ url: env.DATABASE_URL });
  const clock = { now: () => new Date() };
  const anonymizer = new AccountAnonymizer(
    prisma,
    new AuditService(prisma),
    clock,
    env.AUTH_HMAC_SECRET,
  );
  const registrations = buildRegistrations({
    sink: createMessageSink(env, logger),
    anonymizer,
    cartExpiry: new CartExpiry(prisma, clock),
    ledger: new LedgerService(prisma),
    logger,
  });
  const workers = startWorkers(registrations, core, logger);
  logger.info(
    { processors: registrations.map((r) => r.queue) },
    `worker started with ${workers.length} processors`,
  );

  const schedulerQueues = SCHEDULES.map((s) => new Queue(s.queue, { connection: core }));
  await Promise.all(
    SCHEDULES.map((s, i) =>
      schedulerQueues[i]!.upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.id }),
    ),
  );

  const health = createHealthServer(
    {
      critical: { redisCore: () => pingRedis(core), database: () => pingDatabase(prisma) },
      degradable: {},
    },
    logger,
  );
  health.listen(env.WORKER_HEALTH_PORT, () =>
    logger.info({ port: env.WORKER_HEALTH_PORT }, 'worker health listening'),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    // Worker.close() waits for active jobs to finish (NFR-REL-007).
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([...schedulerQueues.map((q) => q.close()), prisma.$disconnect()]);
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
