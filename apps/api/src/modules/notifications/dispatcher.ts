import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { uuidv7 } from '@fos/shared';
import type { Message } from './templates';

/** Sends account messages asynchronously; delivery happens in the worker (FR-NOTIF-001/007). */
export interface MessageDispatcher {
  send(message: Message): Promise<void>;
}

export const SEND_MESSAGE_JOB = 'send-message';

/**
 * Enqueues on the `notifications` queue. Job data can contain an OTP, so jobs
 * are removed as soon as they complete and failed jobs expire within an hour.
 */
export class QueueMessageDispatcher implements MessageDispatcher {
  private readonly queue: Queue;

  constructor(connection: Redis) {
    this.queue = new Queue('notifications', { connection });
  }

  async send(message: Message): Promise<void> {
    await this.queue.add(SEND_MESSAGE_JOB, message, {
      jobId: uuidv7(),
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: { age: 3600 },
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** In-memory dispatcher for tests: records what would have been sent. */
export class RecordingDispatcher implements MessageDispatcher {
  readonly sent: Message[] = [];

  async send(message: Message): Promise<void> {
    this.sent.push(message);
  }

  /** Latest OTP sent to `to`, for tests that need to complete a flow. */
  lastOtp(to: string): string | undefined {
    const found = [...this.sent].reverse().find((m) => m.to === to && m.template === 'OTP');
    return found?.template === 'OTP' ? found.vars.code : undefined;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
