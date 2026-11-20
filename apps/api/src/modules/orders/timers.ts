import type { Order } from '@fos/db';
import type { JobQueue } from '../../platform/jobs';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logger';
import type { SettingsService } from '../config';

export const ORDER_JOBS = {
  paymentTtl: 'payment-ttl', // JOB-ORD-001
  acceptReminder: 'accept-reminder', // JOB-ORD-002 (reminder)
  acceptTimeout: 'accept-timeout', // JOB-ORD-002
  autoPreparing: 'auto-preparing', // JOB-ORD-003
  prepDelay: 'prep-delay', // JOB-ORD-004
  pickupDelay: 'pickup-delay', // JOB-ORD-005 (escalation level in the job id)
  deliveryOverdue: 'delivery-overdue', // JOB-ORD-006
} as const;

/** JOB-ORD-005: minutes after READY_FOR_PICKUP at which ops is alerted. */
export const PICKUP_ALERT_MINUTES = [10, 20, 30] as const;
const PREP_GRACE_MINUTES = 15;
const DELIVERY_OVERDUE_FLOOR_MINUTES = 45;

type TimedOrder = Pick<
  Order,
  | 'id'
  | 'status'
  | 'createdAt'
  | 'placedAt'
  | 'acceptedAt'
  | 'readyBy'
  | 'readyAt'
  | 'pickedUpAt'
  | 'etaMinAt'
>;

/**
 * Order timers on the `orders` queue with deterministic job ids
 * (`{job}-{orderId}`; BullMQ rejects a single `:` in custom ids), so duplicates are ignored; processors re-check the
 * order's state before acting, and the JOB-ORD-007 sweep recreates lost ones.
 */
export class OrderTimers {
  constructor(
    private readonly jobs: JobQueue,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  private secondsUntil(from: Date, plusSeconds: number): number {
    return (from.getTime() + plusSeconds * 1000 - this.clock.now().getTime()) / 1000;
  }

  private async at(name: string, orderId: string, delaySeconds: number, jobKey = name) {
    await this.jobs
      .enqueue(
        'orders',
        name,
        { orderId },
        { jobId: `${jobKey}-${orderId}`, delayMs: Math.max(0, delaySeconds) * 1000 },
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

  /** JOB-ORD-004: `readyBy` + 15 min, alert only. */
  async afterPreparing(order: Pick<Order, 'id' | 'readyBy'>) {
    if (order.readyBy)
      await this.at(
        ORDER_JOBS.prepDelay,
        order.id,
        this.secondsUntil(order.readyBy, PREP_GRACE_MINUTES * 60),
      );
  }

  /** JOB-ORD-005: escalating alerts while nobody has picked the order up. */
  async afterReady(order: Pick<Order, 'id' | 'readyAt'>) {
    const readyAt = order.readyAt ?? this.clock.now();
    for (const minutes of PICKUP_ALERT_MINUTES) {
      await this.at(
        ORDER_JOBS.pickupDelay,
        order.id,
        this.secondsUntil(readyAt, minutes * 60),
        `${ORDER_JOBS.pickupDelay}-${minutes}`,
      );
    }
  }

  /** JOB-ORD-006: max(2 × ETA, 45 min) after pickup. */
  async afterPickedUp(order: Pick<Order, 'id' | 'pickedUpAt' | 'placedAt' | 'etaMinAt'>) {
    const pickedUpAt = order.pickedUpAt ?? this.clock.now();
    const etaMinutes =
      order.etaMinAt && order.placedAt
        ? (order.etaMinAt.getTime() - order.placedAt.getTime()) / 60_000
        : 0;
    const minutes = Math.max(2 * etaMinutes, DELIVERY_OVERDUE_FLOOR_MINUTES);
    await this.at(
      ORDER_JOBS.deliveryOverdue,
      order.id,
      this.secondsUntil(pickedUpAt, minutes * 60),
    );
  }

  /**
   * JOB-ORD-007: re-creates the timers an order in `status` should have, with
   * the remaining delay. Deterministic job ids make this safe to repeat.
   */
  async resume(order: TimedOrder) {
    switch (order.status) {
      case 'PAYMENT_PENDING':
        await this.at(
          ORDER_JOBS.paymentTtl,
          order.id,
          this.secondsUntil(order.createdAt, await this.settings.get('order.paymentTtlSeconds')),
        );
        break;
      case 'PLACED': {
        const placedAt = order.placedAt ?? order.createdAt;
        await this.at(
          ORDER_JOBS.acceptReminder,
          order.id,
          this.secondsUntil(placedAt, await this.settings.get('order.acceptReminderSeconds')),
        );
        await this.at(
          ORDER_JOBS.acceptTimeout,
          order.id,
          this.secondsUntil(placedAt, await this.settings.get('order.acceptTimeoutSeconds')),
        );
        break;
      }
      case 'ACCEPTED': {
        const seconds = await this.settings.get('order.autoPreparingSeconds');
        if (seconds > 0 && order.acceptedAt)
          await this.at(
            ORDER_JOBS.autoPreparing,
            order.id,
            this.secondsUntil(order.acceptedAt, seconds),
          );
        break;
      }
      case 'PREPARING':
        await this.afterPreparing(order);
        break;
      case 'READY_FOR_PICKUP':
        await this.afterReady(order);
        break;
      case 'PICKED_UP':
        await this.afterPickedUp(order);
        break;
      default:
    }
  }
}
