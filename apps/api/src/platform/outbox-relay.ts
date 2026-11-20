import { randomUUID } from 'node:crypto';
import type { OutboxEvent, PrismaClient } from '@fos/db';
import type { Redis } from 'ioredis';
import type { Clock } from './clock';
import type { Logger } from './logger';
import { raiseOpsAlert } from './ops-alerts';

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

const LEADER_KEY = 'outbox:relay:leader';
const LEADER_TTL_MS = 15_000;
/** ERROR-HANDLING: alert when the oldest unpublished event is older than this. */
const STALE_MS = 60_000;
const ALERT_AFTER_ATTEMPTS = 5;

/**
 * Transactional-outbox relay (ADR-010). Reads unpublished events in sequence
 * order, hands each to the consumers registered for its type and marks it
 * published once every consumer succeeded. Consumers must be idempotent: a
 * crash between consuming and marking replays the event.
 *
 * One leader at a time via a Redis lock with TTL. When a consumer fails, later
 * events of the same aggregate wait so per-aggregate order is kept.
 */
export class OutboxRelay {
  private readonly handlers = new Map<string, OutboxHandler[]>();
  private readonly token = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis | null,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** `type` is an exact event type, a prefix pattern such as `order.*`, or `*`. */
  on(type: string, handler: OutboxHandler): this {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
    return this;
  }

  private handlersFor(eventType: string): OutboxHandler[] {
    const prefix = eventType.split('.')[0];
    return [
      ...(this.handlers.get(eventType) ?? []),
      ...(this.handlers.get(`${prefix}.*`) ?? []),
      ...(this.handlers.get('*') ?? []),
    ];
  }

  /** Publishes one batch; returns how many events were marked published. */
  async runOnce(limit = 100): Promise<number> {
    const events = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { sequence: 'asc' },
      take: limit,
    });
    const blocked = new Set<string>();
    let published = 0;
    for (const event of events) {
      const key = `${event.aggregateType}:${event.aggregateId}`;
      if (blocked.has(key)) continue;
      try {
        for (const handler of this.handlersFor(event.eventType)) await handler(event);
        await this.prisma.outboxEvent.update({
          where: { sequence: event.sequence },
          data: { publishedAt: this.clock.now(), attempts: { increment: 1 } },
        });
        published++;
      } catch (error) {
        blocked.add(key);
        const { attempts } = await this.prisma.outboxEvent.update({
          where: { sequence: event.sequence },
          data: { attempts: { increment: 1 } },
          select: { attempts: true },
        });
        this.logger.error(
          { err: error, eventId: event.eventId, eventType: event.eventType, attempts },
          'outbox consumer failed; will retry',
        );
        if (attempts >= ALERT_AFTER_ATTEMPTS) {
          await raiseOpsAlert(this.prisma, {
            type: 'OUTBOX_CONSUMER_FAILING',
            severity: 'CRITICAL',
            message: `Event ${event.eventType} (${event.eventId}) failed ${attempts} times.`,
            dedupeKey: `outbox:${event.eventId}`,
          }).catch(() => undefined);
        }
      }
    }
    return published;
  }

  /** JOB-OUTBOX-001: alert when events wait too long (relay down or a consumer stuck). */
  async checkStale(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - STALE_MS);
    const stale = await this.prisma.outboxEvent.count({
      where: { publishedAt: null, createdAt: { lt: cutoff } },
    });
    if (stale > 0) {
      await raiseOpsAlert(this.prisma, {
        type: 'OUTBOX_STALE',
        severity: 'CRITICAL',
        message: `${stale} outbox event(s) unpublished for more than ${STALE_MS / 1000}s.`,
        dedupeKey: 'outbox:stale',
      });
    }
    return stale;
  }

  private async leader(): Promise<boolean> {
    if (!this.redis) return true;
    const held = await this.redis.get(LEADER_KEY);
    if (held === this.token) {
      await this.redis.pexpire(LEADER_KEY, LEADER_TTL_MS);
      return true;
    }
    return (await this.redis.set(LEADER_KEY, this.token, 'PX', LEADER_TTL_MS, 'NX')) === 'OK';
  }

  /** Polls every `intervalMs` while this instance holds the leader lock. */
  start(intervalMs = 500): void {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        if (await this.leader()) {
          // Drain quickly when there is a backlog.
          while ((await this.runOnce()) === 100) {
            /* keep going */
          }
        }
      } catch (error) {
        this.logger.error({ err: error }, 'outbox relay tick failed');
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 20));
    if (this.redis && (await this.redis.get(LEADER_KEY)) === this.token) {
      await this.redis.del(LEADER_KEY);
    }
  }
}
