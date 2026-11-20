import type {
  ClientApp,
  NotificationCategory,
  NotificationChannel,
  NotificationTemplate,
  Prisma,
  PrismaClient,
} from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { JobQueue } from '../../platform/jobs';
import type { Logger } from '../../platform/logger';
import { decodeCursor, encodeCursor, queryFingerprint } from '../../platform/pagination';
import {
  DEFAULT_TEMPLATES,
  fill,
  MANDATORY_CATEGORIES,
  OPTIONAL_CATEGORIES,
  PREFERENCE_CHANNELS,
  type TemplateDefinition,
} from './catalog';

export const DELIVER_NOTIFICATION_JOB = 'deliver-notification';

export interface NotifyInput {
  /** The domain event this notification comes from; with user and channel it makes sends idempotent. */
  eventId: string;
  userId: string;
  key: string;
  vars: Record<string, string | number>;
  data?: Record<string, unknown>;
}

const EXTERNAL: NotificationChannel[] = ['PUSH', 'SMS', 'EMAIL'];

/**
 * Central notification dispatch (FR-NOTIF-001…009). Channels come from the
 * template and the recipient's preferences; in-app entries are written at
 * once, external channels are delivered by the worker with retries.
 */
export class NotificationService {
  private templates: Map<string, NotificationTemplate[]> | null = null;
  private loadedAt = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobs: JobQueue,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  private definition(key: string): TemplateDefinition {
    const d = DEFAULT_TEMPLATES.find((t) => t.key === key);
    if (!d) throw new Error(`unknown notification template ${key}`);
    return d;
  }

  /** Latest active version per (key, channel), creating version 1 of the defaults when absent. */
  private async templatesFor(key: string): Promise<NotificationTemplate[]> {
    if (!this.templates || Date.now() - this.loadedAt > 60_000) {
      const def = DEFAULT_TEMPLATES;
      const rows = await this.prisma.notificationTemplate.findMany({
        where: { active: true, locale: 'en-IN' },
        orderBy: { version: 'desc' },
      });
      const missing = def.flatMap((d) =>
        Object.entries(d.channels)
          .filter(([ch]) => !rows.some((r) => r.key === d.key && r.channel === ch))
          .map(([ch, text]) => ({
            key: d.key,
            channel: ch as NotificationChannel,
            locale: 'en-IN',
            version: 1,
            category: d.category,
            subject: text.subject ?? null,
            body: text.body,
            variablesSchema: { required: d.variables },
          })),
      );
      if (missing.length > 0) {
        await this.prisma.notificationTemplate.createMany({ data: missing, skipDuplicates: true });
        return this.reload(key);
      }
      this.index(rows);
    }
    return this.templates!.get(key) ?? [];
  }

  private async reload(key: string) {
    this.index(
      await this.prisma.notificationTemplate.findMany({
        where: { active: true, locale: 'en-IN' },
        orderBy: { version: 'desc' },
      }),
    );
    return this.templates!.get(key) ?? [];
  }

  private index(rows: NotificationTemplate[]) {
    const map = new Map<string, NotificationTemplate[]>();
    for (const r of rows) {
      const list = map.get(r.key) ?? [];
      if (!list.some((x) => x.channel === r.channel)) list.push(r); // newest version wins
      map.set(r.key, list);
    }
    this.templates = map;
    this.loadedAt = Date.now();
  }

  private async optedOut(userId: string, category: NotificationCategory) {
    if (MANDATORY_CATEGORIES.has(category)) return new Set<NotificationChannel>();
    const rows = await this.prisma.notificationPreference.findMany({
      where: { userId, category, enabled: false },
      select: { channel: true },
    });
    return new Set(rows.map((r) => r.channel));
  }

  /** FR-NOTIF-001: one event to one recipient, every channel the template has. Idempotent per event. */
  async notify(input: NotifyInput): Promise<void> {
    const def = this.definition(input.key);
    const templates = await this.templatesFor(input.key);
    const off = await this.optedOut(input.userId, def.category);
    const queued: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const t of templates) {
        if (off.has(t.channel) || t.channel === 'SOCKET') continue;
        // Render now so a missing variable fails the event, not a later job.
        const title = fill(t.subject ?? def.key, input.vars).slice(0, 120);
        const body = fill(t.body, input.vars);
        const created = await tx.notificationDelivery.createMany({
          data: [
            {
              eventId: input.eventId,
              userId: input.userId,
              templateId: t.id,
              channel: t.channel,
              status: t.channel === 'IN_APP' ? 'SENT' : 'PENDING',
              ...(t.channel === 'IN_APP' ? { sentAt: this.clock.now(), provider: 'inbox' } : {}),
            },
          ],
          skipDuplicates: true,
        });
        if (created.count === 0) continue; // already sent for this event
        if (t.channel === 'IN_APP') {
          await tx.notification.create({
            data: {
              userId: input.userId,
              app: def.app,
              category: def.category,
              title,
              body: body.slice(0, 500),
              deepLink: def.deepLink ? fill(def.deepLink, input.vars) : null,
              data: { ...(input.data ?? {}), key: input.key } as Prisma.InputJsonValue,
              createdAt: this.clock.now(),
            },
          });
        } else if (EXTERNAL.includes(t.channel)) {
          const row = await tx.notificationDelivery.findUniqueOrThrow({
            where: {
              eventId_userId_channel: {
                eventId: input.eventId,
                userId: input.userId,
                channel: t.channel,
              },
            },
            select: { id: true },
          });
          queued.push(row.id);
        }
      }
    });
    for (const id of queued) {
      await this.jobs
        .enqueue(
          'notifications',
          DELIVER_NOTIFICATION_JOB,
          { deliveryId: id, vars: input.vars },
          {
            jobId: `ntf-${id}`,
          },
        )
        .catch((error: unknown) =>
          this.logger.warn({ err: error, deliveryId: id }, 'could not queue notification delivery'),
        );
    }
  }

  /* ----------------------------- inbox (API-NTF-001…006) ----------------------------- */

  async inbox(
    userId: string,
    app: ClientApp,
    opts: { unread?: boolean | undefined; limit: number; cursor?: string | undefined },
  ) {
    const context = queryFingerprint(['inbox', userId, app, opts.unread]);
    const after = opts.cursor ? decodeCursor(opts.cursor, context) : null;
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        app,
        deletedAt: null,
        ...(opts.unread ? { readAt: null } : {}),
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after[0] as number) } },
                { createdAt: new Date(after[0] as number), id: { lt: after[1] as string } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
    });
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      items: page.map(view),
      nextCursor:
        rows.length > opts.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }

  async unreadCount(userId: string, app: ClientApp) {
    return {
      unread: await this.prisma.notification.count({
        where: { userId, app, deletedAt: null, readAt: null },
      }),
    };
  }

  private async own(userId: string, id: string) {
    const n = await this.prisma.notification.findFirst({ where: { id, userId, deletedAt: null } });
    if (!n) throw new AppError('NOT_FOUND', { message: "We couldn't find that notification." });
    return n;
  }

  async get(userId: string, id: string) {
    return view(await this.own(userId, id));
  }

  async markRead(userId: string, id: string) {
    const n = await this.own(userId, id);
    if (n.readAt) return view(n);
    return view(
      await this.prisma.notification.update({ where: { id }, data: { readAt: this.clock.now() } }),
    );
  }

  async markAllRead(userId: string, app: ClientApp) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, app, readAt: null, deletedAt: null },
      data: { readAt: this.clock.now() },
    });
    return { updated: count };
  }

  async hide(userId: string, id: string) {
    await this.own(userId, id);
    await this.prisma.notification.update({ where: { id }, data: { deletedAt: this.clock.now() } });
  }

  /* ----------------------------- preferences (API-NTF-007/008) ----------------------------- */

  async preferences(userId: string) {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    return {
      mandatory: [...MANDATORY_CATEGORIES],
      categories: OPTIONAL_CATEGORIES.map((category) => ({
        category,
        channels: Object.fromEntries(
          PREFERENCE_CHANNELS.map((ch) => [
            ch,
            rows.find((r) => r.category === category && r.channel === ch)?.enabled ?? true,
          ]),
        ),
      })),
    };
  }

  async setPreferences(
    userId: string,
    prefs: {
      category: (typeof OPTIONAL_CATEGORIES)[number];
      channel: (typeof PREFERENCE_CHANNELS)[number];
      enabled: boolean;
    }[],
  ) {
    await this.prisma.$transaction(
      prefs.map((p) =>
        this.prisma.notificationPreference.upsert({
          where: { userId_category_channel: { userId, category: p.category, channel: p.channel } },
          create: { userId, ...p },
          update: { enabled: p.enabled },
        }),
      ),
    );
    return this.preferences(userId);
  }

  /* ----------------------------- push (API-NTF-009/010) ----------------------------- */

  /** One subscription per session; re-registering the same endpoint moves it to this session. */
  async registerPush(
    auth: { userId: string; sessionId: string },
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.pushSubscription.deleteMany({
        where: { sessionId: auth.sessionId, endpoint: { not: sub.endpoint } },
      });
      const row = await tx.pushSubscription.upsert({
        where: { endpoint: sub.endpoint },
        create: {
          userId: auth.userId,
          sessionId: auth.sessionId,
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
        update: {
          userId: auth.userId,
          sessionId: auth.sessionId,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
      });
      return { id: row.id, createdAt: row.createdAt };
    });
  }

  async unregisterPush(userId: string, id: string) {
    const { count } = await this.prisma.pushSubscription.deleteMany({ where: { id, userId } });
    if (count === 0)
      throw new AppError('NOT_FOUND', { message: "We couldn't find that subscription." });
  }
}

function view(n: {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  deepLink: string | null;
  data: unknown;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: n.id,
    category: n.category,
    title: n.title,
    body: n.body,
    deepLink: n.deepLink,
    data: n.data,
    read: n.readAt !== null,
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}
