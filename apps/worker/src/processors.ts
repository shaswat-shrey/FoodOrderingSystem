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

/** Job processors registered by domain modules; more are added as modules are built. */
export function buildRegistrations(sink: MessageSink): ProcessorRegistration[] {
  return [
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
