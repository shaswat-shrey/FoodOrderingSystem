import { resolve } from 'node:path';
import { Worker, type ConnectionOptions, type Processor } from 'bullmq';
import type { QueueName } from '@fos/shared';
import type { Logger } from '@fos/api/platform';
import {
  FileMessageSink,
  LogMessageSink,
  SEND_MESSAGE_JOB,
  type Message,
  type MessageSink,
} from '@fos/api/notifications';
import type { AccountAnonymizer, CartExpiry } from '@fos/api/jobs';
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

/** Repeatable jobs (BullMQ job schedulers), registered idempotently at boot. */
export const SCHEDULES = [
  // JOB-USER-001: hourly sweep for accounts past their deletion grace period.
  { queue: 'maintenance', id: ANONYMIZE_DUE_USERS_JOB, everyMs: 60 * 60 * 1000 },
  // JOB-CART-001: hourly expiry of carts idle for 7 days (BR-CART-002).
  { queue: 'maintenance', id: EXPIRE_IDLE_CARTS_JOB, everyMs: 60 * 60 * 1000 },
] as const satisfies { queue: QueueName; id: string; everyMs: number }[];

export interface JobServices {
  sink: MessageSink;
  anonymizer: AccountAnonymizer;
  cartExpiry: CartExpiry;
  logger: Logger;
}

/** Job processors registered by domain modules; more are added as modules are built. */
export function buildRegistrations({
  sink,
  anonymizer,
  cartExpiry,
  logger,
}: JobServices): ProcessorRegistration[] {
  const maintenance: Record<string, () => Promise<void>> = {
    [ANONYMIZE_DUE_USERS_JOB]: async () => {
      const count = await anonymizer.run();
      if (count > 0) logger.info({ count }, 'anonymised accounts past their deletion grace period');
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
      queue: 'notifications',
      concurrency: 20,
      processor: async (job) => {
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
