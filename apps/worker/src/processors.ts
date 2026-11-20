import { resolve } from 'node:path';
import { Worker, type ConnectionOptions, type Processor } from 'bullmq';
import type { QueueName } from '@fos/shared';
import type { Logger } from '@fos/api/platform';
import {
  DELIVER_NOTIFICATION_JOB,
  FileMessageSink,
  LogMessageSink,
  SEND_MESSAGE_JOB,
  type Message,
  type MessageSink,
} from '@fos/api/notifications';
import {
  PROCESS_WEBHOOK_JOB,
  SUBMIT_REFUND_JOB,
  type AccountAnonymizer,
  type CartExpiry,
  type BranchOpsService,
  DISPATCH_JOBS,
  type DeliveryStagesService,
  type LiveTracking,
  type DispatchService,
  type FilesService,
  type PartnerAvailabilityService,
  type LedgerService,
  type NotificationDeliverer,
  type OrderTimerJobs,
  type OutboxRelay,
  type PaymentsService,
  type RefundService,
} from '@fos/api/jobs';
import type { WorkerEnv } from './env';

export interface ProcessorRegistration {
  queue: QueueName;
  processor: Processor;
  /** Parallel jobs per worker instance (EVENTS-AND-JOBS §4). */
  concurrency: number;
}

/** Chooses where account messages go. Production needs real providers (Phase 7). */
export function createMessageSink(env: WorkerEnv, logger: Logger): MessageSink {
  if (env.NODE_ENV === 'production') {
    throw new Error('No SMS/email provider is configured; production delivery arrives in Phase 7.');
  }
  return env.DEV_MESSAGE_SINK === 'file'
    ? new FileMessageSink(resolve(process.cwd(), '../..', env.DEV_MESSAGE_FILE))
    : new LogMessageSink(logger);
}

export const ANONYMIZE_DUE_USERS_JOB = 'anonymize-due-users';
export const EXPIRE_IDLE_CARTS_JOB = 'expire-idle-carts';
export const VERIFY_LEDGER_JOB = 'verify-ledger';
export const SWEEP_WEBHOOKS_JOB = 'sweep-payment-webhooks';
export const SWEEP_REFUNDS_JOB = 'sweep-refunds';
export const RESOLVE_STUCK_PAYMENTS_JOB = 'resolve-stuck-payments';
export const SWEEP_ORDER_TIMERS_JOB = 'sweep-order-timers';
export const EXPIRE_CHECKOUT_SESSIONS_JOB = 'expire-checkout-sessions';
export const OUTBOX_HEALTH_JOB = 'outbox-health';
export const CLEANUP_ORPHAN_FILES_JOB = 'cleanup-orphan-files';
export const SWEEP_BRANCH_STATUS_JOB = 'sweep-branch-status';
export const SWEEP_PARTNERS_JOB = 'sweep-partners';
export const SWEEP_DISPATCH_JOB = 'sweep-dispatch';

/** Repeatable jobs (BullMQ job schedulers), registered idempotently at boot. */
export const SCHEDULES = [
  // JOB-USER-001: hourly sweep for accounts past their deletion grace period.
  { queue: 'maintenance', id: ANONYMIZE_DUE_USERS_JOB, everyMs: 60 * 60 * 1000 },
  // JOB-CART-001: hourly expiry of carts idle for 7 days (BR-CART-002).
  { queue: 'maintenance', id: EXPIRE_IDLE_CARTS_JOB, everyMs: 60 * 60 * 1000 },
  // JOB-LEDGER-001 (FR-RECON-003): daily check that cached balances match their entries.
  { queue: 'maintenance', id: VERIFY_LEDGER_JOB, everyMs: 24 * 60 * 60 * 1000 },
  // FR-PAY-004: webhook events whose job was lost; FR-REFUND-005/006: due and unconfirmed refunds.
  { queue: 'maintenance', id: SWEEP_WEBHOOKS_JOB, everyMs: 60 * 1000 },
  { queue: 'maintenance', id: SWEEP_REFUNDS_JOB, everyMs: 60 * 1000 },
  // FR-RECON-004 / JOB-PAY-004: payments stuck PENDING/AUTHORIZED.
  { queue: 'maintenance', id: RESOLVE_STUCK_PAYMENTS_JOB, everyMs: 60 * 60 * 1000 },
  // JOB-ORD-007: self-healing order timers; JOB-CHK-001: expired checkout sessions.
  { queue: 'orders', id: SWEEP_ORDER_TIMERS_JOB, everyMs: 5 * 60 * 1000 },
  { queue: 'maintenance', id: EXPIRE_CHECKOUT_SESSIONS_JOB, everyMs: 5 * 60 * 1000 },
  // JOB-OUTBOX-001: stale-event alert.
  { queue: 'maintenance', id: OUTBOX_HEALTH_JOB, everyMs: 60 * 1000 },
  // JOB-FILE-002 (FR-FILE-006): uploads never attached to anything.
  { queue: 'maintenance', id: CLEANUP_ORPHAN_FILES_JOB, everyMs: 60 * 60 * 1000 },
  // JOB-REST-001/002: expired pauses resume; "closed for today" reopens next day.
  { queue: 'maintenance', id: SWEEP_BRANCH_STATUS_JOB, everyMs: 5 * 60 * 1000 },
  // JOB-DP-001 (BR-DEL-006): silent or out-of-zone partners go offline; breaks end.
  { queue: 'maintenance', id: SWEEP_PARTNERS_JOB, everyMs: 60 * 1000 },
  // Self-healing dispatch: lost start/timeout jobs (cf. JOB-ORD-007).
  { queue: 'maintenance', id: SWEEP_DISPATCH_JOB, everyMs: 60 * 1000 },
] as const satisfies { queue: QueueName; id: string; everyMs: number }[];

export interface JobServices {
  sink: MessageSink;
  anonymizer: AccountAnonymizer;
  cartExpiry: Pick<CartExpiry, 'run' | 'expireSessions'>;
  ledger: Pick<LedgerService, 'verify'>;
  payments: Pick<PaymentsService, 'processWebhook' | 'processPendingWebhooks' | 'resolveStuck'>;
  refunds: Pick<RefundService, 'submit' | 'sweep'>;
  orderJobs: Pick<OrderTimerJobs, 'run' | 'sweep'>;
  outbox: Pick<OutboxRelay, 'checkStale'>;
  deliverer: Pick<NotificationDeliverer, 'deliver'>;
  files: Pick<FilesService, 'cleanupOrphans'>;
  branchOps: Pick<BranchOpsService, 'sweep'>;
  partners: Pick<PartnerAvailabilityService, 'sweep'>;
  dispatch: Pick<DispatchService, 'start' | 'expire' | 'retry' | 'sweep'>;
  deliveryStages: Pick<DeliveryStagesService, 'heartbeatSweep'>;
  liveTracking: Pick<LiveTracking, 'sweepStale'>;
  logger: Logger;
}

/** Job processors registered by domain modules; more are added as modules are built. */
export function buildRegistrations({
  sink,
  anonymizer,
  cartExpiry,
  ledger,
  payments,
  refunds,
  orderJobs,
  outbox,
  deliverer,
  files,
  branchOps,
  partners,
  dispatch,
  deliveryStages,
  liveTracking,
  logger,
}: JobServices): ProcessorRegistration[] {
  const maintenance: Record<string, () => Promise<void>> = {
    [ANONYMIZE_DUE_USERS_JOB]: async () => {
      const count = await anonymizer.run();
      if (count > 0) logger.info({ count }, 'anonymised accounts past their deletion grace period');
    },
    [VERIFY_LEDGER_JOB]: async () => {
      const mismatches = await ledger.verify();
      // A mismatch is a P1 incident (FR-RECON-003); failing the job surfaces it.
      if (mismatches.length > 0) {
        logger.error(
          { count: mismatches.length, accounts: mismatches.slice(0, 20).map((m) => m.accountId) },
          'ledger balance mismatch',
        );
        throw new Error(`ledger integrity check failed for ${mismatches.length} account(s)`);
      }
    },
    [SWEEP_WEBHOOKS_JOB]: async () => {
      await payments.processPendingWebhooks();
    },
    [SWEEP_REFUNDS_JOB]: async () => {
      await refunds.sweep();
    },
    [RESOLVE_STUCK_PAYMENTS_JOB]: async () => {
      const count = await payments.resolveStuck();
      if (count > 0) logger.info({ count }, 'resolved stuck payments from the provider');
    },
    [EXPIRE_CHECKOUT_SESSIONS_JOB]: async () => {
      const count = await cartExpiry.expireSessions();
      if (count > 0) logger.info({ count }, 'expired checkout sessions');
    },
    [SWEEP_DISPATCH_JOB]: async () => {
      await dispatch.sweep();
      // Assigned partners who went silent: alert at 3 min, release at 5 (algorithm §8).
      const { released } = await deliveryStages.heartbeatSweep();
      if (released > 0) logger.warn({ released }, 'released deliveries from silent partners');
      await liveTracking.sweepStale(); // FR-TRK-005
    },
    [SWEEP_PARTNERS_JOB]: async () => {
      await partners.sweep();
    },
    [SWEEP_BRANCH_STATUS_JOB]: async () => {
      await branchOps.sweep();
    },
    [CLEANUP_ORPHAN_FILES_JOB]: async () => {
      const count = await files.cleanupOrphans();
      if (count > 0) logger.info({ count }, 'deleted orphan uploads');
    },
    [OUTBOX_HEALTH_JOB]: async () => {
      await outbox.checkStale();
    },
    [EXPIRE_IDLE_CARTS_JOB]: async () => {
      const count = await cartExpiry.run();
      if (count > 0) logger.info({ count }, 'expired idle carts');
    },
  };
  return [
    {
      queue: 'maintenance',
      concurrency: 1,
      processor: async (job) => {
        const run = maintenance[job.name];
        if (!run) throw new Error(`Unknown maintenance job: ${job.name}`);
        await run();
      },
    },
    {
      // JOB-ORD-001…007: per-order timers (job data carries the order id) and the sweeper.
      queue: 'orders',
      concurrency: 10,
      processor: async (job) => {
        if (job.name === SWEEP_ORDER_TIMERS_JOB) {
          await orderJobs.sweep();
          return;
        }
        await orderJobs.run(job.name, String((job.data as { orderId: string }).orderId));
      },
    },
    {
      // JOB-DISP-001…003: dispatch start, offer timeout, escalated re-search.
      queue: 'dispatch',
      concurrency: 20,
      processor: async (job) => {
        const data = job.data as { deliveryId?: string; assignmentId?: string };
        if (job.name === DISPATCH_JOBS.start) return dispatch.start(String(data.deliveryId));
        if (job.name === DISPATCH_JOBS.offerTimeout)
          return dispatch.expire(String(data.assignmentId));
        if (job.name === DISPATCH_JOBS.retry) return dispatch.retry(String(data.deliveryId));
        throw new Error(`Unknown dispatch job: ${job.name}`);
      },
    },
    {
      // JOB-PAY-001: one webhook event per job; ordering per payment comes from its row lock.
      queue: 'payments',
      concurrency: 10,
      processor: async (job) => {
        if (job.name !== PROCESS_WEBHOOK_JOB) throw new Error(`Unknown payments job: ${job.name}`);
        await payments.processWebhook(String((job.data as { eventRowId: string }).eventRowId));
      },
    },
    {
      // JOB-REFUND-001
      queue: 'refunds',
      concurrency: 5,
      processor: async (job) => {
        if (job.name !== SUBMIT_REFUND_JOB) throw new Error(`Unknown refunds job: ${job.name}`);
        await refunds.submit(String((job.data as { refundId: string }).refundId));
      },
    },
    {
      queue: 'notifications',
      concurrency: 20,
      processor: async (job) => {
        if (job.name === DELIVER_NOTIFICATION_JOB) {
          // JOB-NOTIF-001
          const data = job.data as { deliveryId: string; vars: Record<string, string | number> };
          await deliverer.deliver(data.deliveryId, data.vars);
          return;
        }
        if (job.name !== SEND_MESSAGE_JOB)
          throw new Error(`Unknown notifications job: ${job.name}`);
        await sink.deliver(job.data as Message);
      },
    },
  ];
}

export function startWorkers(
  list: ProcessorRegistration[],
  connection: ConnectionOptions,
  logger: Logger,
): Worker[] {
  return list.map(({ queue, processor, concurrency }) => {
    const worker = new Worker(queue, processor, { connection, concurrency });
    // Job payloads may contain OTPs, so only ids and outcomes are logged.
    worker.on('completed', (job) =>
      logger.info({ queue, jobId: job.id, job: job.name }, 'job completed'),
    );
    worker.on('failed', (job, error) =>
      logger.error(
        { queue, jobId: job?.id, job: job?.name, attempt: job?.attemptsMade, err: error },
        'job failed',
      ),
    );
    worker.on('error', (error) => logger.error({ queue, err: error }, 'worker error'));
    return worker;
  });
}
