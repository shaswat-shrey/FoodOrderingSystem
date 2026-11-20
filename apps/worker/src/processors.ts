import { Worker, type ConnectionOptions, type Processor } from 'bullmq';
import type { QueueName } from '@fos/shared';
import type { Logger } from '@fos/api/platform';

export interface ProcessorRegistration {
  queue: QueueName;
  processor: Processor;
  /** Parallel jobs per worker instance (EVENTS-AND-JOBS §4). */
  concurrency: number;
}

/**
 * Job processors registered by domain modules. Empty in Phase 2: each module
 * adds its processors here when it is implemented (e.g. JOB-ORD-* in Phase 7).
 */
export const registrations: ProcessorRegistration[] = [];

export function startWorkers(
  list: ProcessorRegistration[],
  connection: ConnectionOptions,
  logger: Logger,
): Worker[] {
  return list.map(({ queue, processor, concurrency }) => {
    const worker = new Worker(queue, processor, { connection, concurrency });
    worker.on('completed', (job) =>
      logger.info({ queue, jobId: job.id, attempt: job.attemptsMade }, 'job completed'),
    );
    worker.on('failed', (job, error) =>
      logger.error({ queue, jobId: job?.id, attempt: job?.attemptsMade, err: error }, 'job failed'),
    );
    worker.on('error', (error) => logger.error({ queue, err: error }, 'worker error'));
    return worker;
  });
}
