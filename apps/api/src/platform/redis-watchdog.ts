import type { PrismaClient } from '@fos/db';
import type { Redis } from 'ioredis';
import type { Logger } from './logger';
import { raiseOpsAlert } from './ops-alerts';
import { redisReady } from './redis';

const DEDUPE_KEY = 'redis:core-unavailable';

/**
 * NFR-AVAIL-004: tells operations when the core Redis is gone. Dispatch, scheduled
 * jobs and live updates depend on it and pause during an outage (orders, sign-in
 * and refresh keep working from the database); every BullMQ-driven check is down
 * with it, so this runs on a plain timer and writes to PostgreSQL only. The alert
 * is resolved when Redis is back.
 */
export class RedisWatchdog {
  private downSince: number | null = null;
  private alerted = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly logger: Logger,
    /** How long Redis must be unavailable before ops are alerted. */
    private readonly graceMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  async check(): Promise<'ok' | 'down' | 'alerted'> {
    if (redisReady(this.redis)) {
      this.downSince = null;
      if (this.alerted) {
        await this.prisma.opsAlert.updateMany({
          where: { dedupeKey: DEDUPE_KEY, status: { not: 'RESOLVED' } },
          data: { status: 'RESOLVED', resolvedAt: new Date(this.now()) },
        });
        this.alerted = false;
        this.logger.info('redis back; dispatch and jobs resume');
      }
      return 'ok';
    }
    this.downSince ??= this.now();
    if (this.now() - this.downSince < this.graceMs) return 'down';
    if (!this.alerted) {
      await raiseOpsAlert(this.prisma, {
        type: 'REDIS_UNAVAILABLE',
        severity: 'CRITICAL',
        message:
          'Redis is unavailable: dispatch, scheduled jobs and live updates are paused. Orders and sign-in continue; queued events are sent when it is back.',
        dedupeKey: DEDUPE_KEY,
      });
      this.alerted = true;
    }
    return 'alerted';
  }

  start(intervalMs = 5_000): void {
    this.timer = setInterval(() => {
      this.check().catch((error: unknown) =>
        this.logger.error({ err: error }, 'redis watchdog check failed'),
      );
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
