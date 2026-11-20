import type { Order } from '@fos/db';
import type { JobQueue } from '../../platform/jobs';
import type { Logger } from '../../platform/logger';
import type { SettingsService } from '../config';

export const ORDER_JOBS = {
  paymentTtl: 'payment-ttl', // JOB-ORD-001
  acceptReminder: 'accept-reminder', // JOB-ORD-002 (reminder)
  acceptTimeout: 'accept-timeout', // JOB-ORD-002
  autoPreparing: 'auto-preparing', // JOB-ORD-003
} as const;

/**
 * Order timers on the `orders` queue with deterministic job ids
 * (`{job}:{orderId}`), so duplicates are ignored; processors re-check the
 * order's state before acting, and the JOB-ORD-007 sweep recreates lost ones.
 */
export class OrderTimers {
  constructor(
    private readonly jobs: JobQueue,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  private async at(name: string, orderId: string, delaySeconds: number) {
    await this.jobs
      .enqueue(
        'orders',
        name,
        { orderId },
        { jobId: `${name}:${orderId}`, delayMs: Math.max(0, delaySeconds) * 1000 },
      )
      .catch((error: unknown) =>
        this.logger.warn(
          { err: error, orderId, job: name },
          'could not schedule order timer; the sweeper will',
        ),
      );
  }

  async afterCreate(order: Pick<Order, 'id' | 'status'>) {
    if (order.status === 'PAYMENT_PENDING')
      await this.at(
        ORDER_JOBS.paymentTtl,
        order.id,
        await this.settings.get('order.paymentTtlSeconds'),
      );
    if (order.status === 'PLACED') await this.afterPlaced(order.id);
  }

  async afterPlaced(orderId: string) {
    await this.at(
      ORDER_JOBS.acceptReminder,
      orderId,
      await this.settings.get('order.acceptReminderSeconds'),
    );
    await this.at(
      ORDER_JOBS.acceptTimeout,
      orderId,
      await this.settings.get('order.acceptTimeoutSeconds'),
    );
  }

  async afterAccepted(orderId: string) {
    const seconds = await this.settings.get('order.autoPreparingSeconds');
    if (seconds > 0) await this.at(ORDER_JOBS.autoPreparing, orderId, seconds);
  }
}
