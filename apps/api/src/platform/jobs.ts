import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { QueueName } from '@fos/shared';

/** Enqueues background work for the worker process. */
export interface JobQueue {
  enqueue(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    opts?: { jobId?: string; delayMs?: number },
  ): Promise<void>;
  close(): Promise<void>;
}

export class BullJobQueue implements JobQueue {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly connection: Redis) {}

  private queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    opts: { jobId?: string; delayMs?: number } = {},
  ): Promise<void> {
    await this.queue(queue).add(name, data, {
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 7 * 86_400 },
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** Test double: records jobs instead of queueing them; like BullMQ, a repeated jobId is ignored. */
export class RecordingJobQueue implements JobQueue {
  readonly jobs: {
    queue: QueueName;
    name: string;
    data: Record<string, unknown>;
    jobId?: string;
    delayMs?: number;
  }[] = [];
  async enqueue(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    opts: { jobId?: string; delayMs?: number } = {},
  ): Promise<void> {
    if (opts.jobId && opts.jobId.split(':').length === 2)
      throw new Error('Custom Id cannot contain :');
    if (opts.jobId && this.jobs.some((j) => j.queue === queue && j.jobId === opts.jobId)) return;
    this.jobs.push({ queue, name, data, ...opts });
  }
  async close(): Promise<void> {}
}
