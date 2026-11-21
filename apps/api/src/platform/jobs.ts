import { Queue } from 'bullmq';
import { redisReady, RedisUnavailableError } from './redis';
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
  /** Dead-letter view (E27, API-ADM-202): jobs that exhausted their attempts, newest first. */
  failed(queue: QueueName, limit: number): Promise<FailedJob[]>;
  /** Re-queues a failed job (API-ADM-203); false when it is not (or no longer) failed. */
  retry(queue: QueueName, jobId: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface FailedJob {
  id: string;
  queue: QueueName;
  name: string;
  data: Record<string, unknown>;
  failedReason: string | null;
  attemptsMade: number;
  createdAt: Date | null;
  failedAt: Date | null;
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
    // Callers catch this and leave the job to a sweeper; waiting would hang the request.
    if (!redisReady(this.connection)) throw new RedisUnavailableError(`queue ${queue}`);
    await this.queue(queue).add(name, data, {
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 7 * 86_400 },
    });
  }

  async failed(queue: QueueName, limit: number): Promise<FailedJob[]> {
    const jobs = await this.queue(queue).getFailed(0, Math.max(0, limit - 1));
    return jobs
      .filter((j) => j?.id)
      .map((j) => ({
        id: j.id!,
        queue,
        name: j.name,
        data: (j.data ?? {}) as Record<string, unknown>,
        failedReason: j.failedReason ?? null,
        attemptsMade: j.attemptsMade,
        createdAt: j.timestamp ? new Date(j.timestamp) : null,
        failedAt: j.finishedOn ? new Date(j.finishedOn) : null,
      }));
  }

  async retry(queue: QueueName, jobId: string): Promise<boolean> {
    const job = await this.queue(queue).getJob(jobId);
    if (!job || (await job.getState()) !== 'failed') return false;
    await job.retry('failed');
    return true;
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

  /** Dead-lettered jobs; tests add them with `fail()`. */
  readonly failedJobs: FailedJob[] = [];

  /** Records a job that exhausted its attempts. */
  fail(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    failedReason: string,
    jobId = `${name}-${this.failedJobs.length + 1}`,
  ): FailedJob {
    const job: FailedJob = {
      id: jobId,
      queue,
      name,
      data,
      failedReason,
      attemptsMade: 5,
      createdAt: new Date(),
      failedAt: new Date(),
    };
    this.failedJobs.unshift(job);
    return job;
  }

  async failed(queue: QueueName, limit: number): Promise<FailedJob[]> {
    return this.failedJobs.filter((j) => j.queue === queue).slice(0, limit);
  }

  async retry(queue: QueueName, jobId: string): Promise<boolean> {
    const at = this.failedJobs.findIndex((j) => j.queue === queue && j.id === jobId);
    if (at < 0) return false;
    const [job] = this.failedJobs.splice(at, 1);
    this.jobs.push({ queue, name: job!.name, data: job!.data, jobId: job!.id });
    return true;
  }

  async close(): Promise<void> {}
}
