import { Queue } from 'bullmq';
import { createPrismaClient, pingDatabase } from '@fos/db';
import {
  AccountAnonymizer,
  AuditService,
  BullJobQueue,
  BranchOpsService,
  BranchRepository,
  CartExpiry,
  DeliveryStagesService,
  DispatchService,
  registerDispatchConsumers,
  EstimatedRouting,
  createStorageProvider,
  FilesService,
  createPaymentProvider,
  InvoiceService,
  LedgerService,
  LogPushSender,
  NotificationDeliverer,
  NotificationService,
  registerNotificationConsumers,
  OffersService,
  OrderCancellationService,
  OrderEffects,
  OrderPaymentReactions,
  OrderSettlement,
  OrderTimerJobs,
  OrderTimers,
  OrderTransitions,
  OutboxRelay,
  PartnerAvailabilityService,
  PartnerEarningsService,
  PresenceStore,
  ServiceabilityService,
  PaymentsService,
  RefundService,
  registerReviewConsumers,
  ReviewService,
  registerOrderConsumers,
  SettingsService,
  WalletService,
} from '@fos/api/jobs';
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
  const ledger = new LedgerService(prisma);
  const jobs = new BullJobQueue(core);
  const provider = createPaymentProvider(env);
  const audit = new AuditService(prisma);
  const wallet = new WalletService(prisma, ledger, clock);
  const refunds = new RefundService(prisma, provider, ledger, wallet, jobs, clock, logger);
  const payments = new PaymentsService(
    prisma,
    provider,
    ledger,
    refunds,
    audit,
    jobs,
    clock,
    logger,
  );
  const transitions = new OrderTransitions(clock);

  const settings = new SettingsService(prisma, logger);
  const routing = new EstimatedRouting(async () => ({
    roadFactor: await settings.get('geo.roadFactor'),
    kmph: await settings.get('geo.motorbikeKmph'),
  }));
  const timers = new OrderTimers(jobs, settings, logger, clock);
  const effects = new OrderEffects(new OffersService(prisma, clock), wallet);
  const reactions = new OrderPaymentReactions(
    prisma,
    transitions,
    effects,
    payments,
    refunds,
    timers,
    logger,
  );
  const orderJobs = new OrderTimerJobs(prisma, transitions, reactions, timers, clock, logger);
  const cancellations = new OrderCancellationService(
    prisma,
    transitions,
    effects,
    payments,
    refunds,
    ledger,
    settings,
    env.AUTH_HMAC_SECRET,
    clock,
    logger,
  );
  orderJobs.onAcceptTimeout = (orderId) => cancellations.acceptTimeout(orderId);
  // ADR-010 puts the relay in the API; it runs here so API instances stay request-only.
  const outbox = new OutboxRelay(prisma, core, clock, logger);
  registerOrderConsumers(outbox, {
    prisma,
    reactions,
    invoices: new InvoiceService(prisma, clock),
  });
  const sink = createMessageSink(env, logger);
  registerNotificationConsumers(outbox, {
    prisma,
    notifications: new NotificationService(prisma, jobs, clock, logger),
  });
  const presence = new PresenceStore(core);
  const partnerAvailability = new PartnerAvailabilityService(
    prisma,
    presence,
    new ServiceabilityService(prisma, new BranchRepository(prisma), routing, settings, clock),
    ledger,
    settings,
    clock,
    logger,
  );
  const dispatch = new DispatchService(
    prisma,
    core,
    presence,
    partnerAvailability,
    ledger,
    settings,
    jobs,
    clock,
    logger,
  );
  partnerAvailability.onLeave = (partnerId) => dispatch.withdrawFor(partnerId);
  partnerAvailability.onIdle = (partnerId) => dispatch.partnerIdle(partnerId);
  dispatch.onNoPartner = (orderId) =>
    cancellations
      .cancel({ orderId, actor: { type: 'SYSTEM' }, reasonCode: 'NO_PARTNER', fault: 'PLATFORM' })
      .then(() => undefined)
      .catch((error: unknown) =>
        logger.warn({ err: error, orderId }, 'no-partner cancellation skipped'),
      );
  const files = new FilesService(
    prisma,
    createStorageProvider(env, env.AUTH_HMAC_SECRET),
    audit,
    clock,
    logger,
  );
  const earnings = new PartnerEarningsService(prisma, ledger, settings, clock);
  dispatch.onCompensate = (tx, delivery, stage) =>
    earnings.compensate(tx, delivery, stage).then(() => undefined);
  const deliveryStages = new DeliveryStagesService(
    prisma,
    transitions,
    timers,
    new OrderSettlement(ledger),
    earnings,
    ledger,
    presence,
    partnerAvailability,
    dispatch,
    files,
    audit,
    settings,
    env.AUTH_HMAC_SECRET,
    clock,
    logger,
  );
  registerDispatchConsumers(outbox, dispatch);
  registerReviewConsumers(outbox, new ReviewService(prisma, files, settings, clock));
  const registrations = buildRegistrations({
    sink,
    anonymizer,
    cartExpiry: new CartExpiry(prisma, clock),
    ledger,
    payments,
    refunds,
    orderJobs,
    outbox,
    partners: partnerAvailability,
    dispatch,
    branchOps: new BranchOpsService(
      prisma,
      new BranchRepository(prisma),
      settings,
      audit,
      clock,
      logger,
    ),
    files,
    deliveryStages,
    deliverer: new NotificationDeliverer(prisma, sink, new LogPushSender(logger), clock, logger),
    logger,
  });
  const workers = startWorkers(registrations, core, logger);
  outbox.start();
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
    await outbox.stop();
    // Worker.close() waits for active jobs to finish (NFR-REL-007).
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([
      ...schedulerQueues.map((q) => q.close()),
      jobs.close(),
      prisma.$disconnect(),
    ]);
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
