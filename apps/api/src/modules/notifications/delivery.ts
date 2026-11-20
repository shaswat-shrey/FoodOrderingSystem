import type { PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logger';
import { fill } from './catalog';
import type { MessageSink } from './sinks';

/** Web Push transport (VAPID). Production sender arrives with the PWA work; dev logs. */
export interface PushSender {
  send(
    sub: { endpoint: string; p256dh: string; auth: string },
    payload: { title: string; body: string; url?: string | null },
  ): Promise<{ gone: boolean }>;
}

export class LogPushSender implements PushSender {
  constructor(private readonly logger: Logger) {}
  async send(sub: { endpoint: string }, payload: { title: string; body: string }) {
    this.logger.info(
      { devPush: { endpoint: sub.endpoint.slice(0, 60), ...payload } },
      'dev push (not sent)',
    );
    return { gone: false };
  }
}

const MAX_ATTEMPTS = 5; // FR-NOTIF-007

/**
 * JOB-NOTIF-001: delivers one external channel of one notification and
 * records the attempt. Throws on transient failure so the queue retries.
 */
export class NotificationDeliverer {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sink: MessageSink,
    private readonly push: PushSender,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async deliver(deliveryId: string, vars: Record<string, string | number>): Promise<void> {
    const d = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        template: true,
        user: { select: { phone: true, email: true, emailVerifiedAt: true, status: true } },
      },
    });
    if (!d || d.status !== 'PENDING') return;
    const skip = (reason: string) =>
      this.prisma.notificationDelivery.update({
        where: { id: d.id },
        data: { status: 'SKIPPED', lastError: reason, attempts: { increment: 1 } },
      });
    if (d.user.status !== 'ACTIVE') {
      await skip('recipient not active');
      return;
    }
    const subject = fill(d.template.subject ?? '', { ...vars }).trim() || 'FoodOrderSystem';
    const text = fill(d.template.body, vars);
    try {
      if (d.channel === 'SMS' || d.channel === 'EMAIL') {
        const to =
          d.channel === 'SMS' ? d.user.phone : d.user.emailVerifiedAt ? d.user.email : null;
        if (!to) {
          await skip(`no verified ${d.channel === 'SMS' ? 'phone' : 'email'}`);
          return;
        }
        await this.sink.deliver({
          channel: d.channel,
          to,
          template: 'RENDERED',
          vars: { subject, text },
        });
        await this.sent(d.id, d.channel === 'SMS' ? 'dev-sms' : 'dev-email');
        return;
      }
      if (d.channel === 'PUSH') {
        // FR-NOTIF-009: only devices whose session is still signed in.
        const subs = await this.prisma.pushSubscription.findMany({
          where: {
            userId: d.userId,
            session: { status: 'ACTIVE', absoluteExpiresAt: { gt: this.clock.now() } },
          },
        });
        if (subs.length === 0) {
          await skip('no push subscription');
          return;
        }
        for (const s of subs) {
          const { gone } = await this.push.send(s, { title: subject, body: text });
          if (gone)
            await this.prisma.pushSubscription
              .delete({ where: { id: s.id } })
              .catch(() => undefined);
        }
        await this.sent(d.id, 'webpush');
        return;
      }
      await skip(`channel ${d.channel} not delivered by the worker`);
    } catch (error) {
      const attempts = d.attempts + 1;
      await this.prisma.notificationDelivery.update({
        where: { id: d.id },
        data: {
          attempts,
          lastError: String(error instanceof Error ? error.message : error).slice(0, 500),
          ...(attempts >= MAX_ATTEMPTS ? { status: 'FAILED' } : {}),
        },
      });
      this.logger.warn({ err: error, deliveryId, attempts }, 'notification delivery failed');
      if (attempts < MAX_ATTEMPTS) throw error;
    }
  }

  private async sent(id: string, provider: string) {
    await this.prisma.notificationDelivery.update({
      where: { id },
      data: { status: 'SENT', provider, sentAt: this.clock.now(), attempts: { increment: 1 } },
    });
  }
}
