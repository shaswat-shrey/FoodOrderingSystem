import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { authenticate, type AuthMiddlewareDeps } from '../auth';
import { OPTIONAL_CATEGORIES, PREFERENCE_CHANNELS } from './catalog';
import type { NotificationService } from './notification.service';

export interface NotificationsRouterDeps extends AuthMiddlewareDeps {
  notifications: NotificationService;
}

const idParams = z.object({ id: schema.idSchema }).strict();
const inboxQuery = schema.cursorPaginationSchema
  .extend({ unread: z.enum(['true', 'false']).optional() })
  .strict();
const prefsBody = z
  .object({
    preferences: z
      .array(
        z
          .object({
            category: z.enum(OPTIONAL_CATEGORIES),
            channel: z.enum(PREFERENCE_CHANNELS),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
const pushBody = z
  .object({
    endpoint: z
      .url()
      .max(1000)
      .refine((u) => u.startsWith('https://'), 'Must be an https URL'),
    keys: z
      .object({ p256dh: z.string().min(16).max(200), auth: z.string().min(8).max(100) })
      .strict(),
  })
  .strict();

/** Inbox, preferences and push subscriptions for any signed-in app (API-NTF-001…010). */
export function notificationsRouter(deps: NotificationsRouterDeps): Router {
  const router = Router();
  const authed: RequestHandler[] = [requireClientApp(), authenticate(deps)];
  router.use(
    ['/me/notifications', '/me/notification-preferences', '/me/push-subscriptions'],
    ...authed,
  );
  const auth = (res: Response) => res.locals.auth!;

  router.get(
    '/me/notifications',
    handle({ query: inboxQuery }, async ({ query, res }) => {
      const page = await deps.notifications.inbox(auth(res).userId, auth(res).app, {
        unread: query.unread === 'true',
        limit: Math.min(query.limit, 50),
        cursor: query.cursor,
      });
      sendOk(res, page.items, { meta: { pagination: { nextCursor: page.nextCursor } } });
    }),
  );
  router.get(
    '/me/notifications/unread-count',
    handle({}, async ({ res }) =>
      sendOk(res, await deps.notifications.unreadCount(auth(res).userId, auth(res).app)),
    ),
  );
  router.post(
    '/me/notifications/read-all',
    handle({}, async ({ res }) =>
      sendOk(res, await deps.notifications.markAllRead(auth(res).userId, auth(res).app)),
    ),
  );
  router.get(
    '/me/notifications/:id',
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await deps.notifications.get(auth(res).userId, params.id)),
    ),
  );
  router.post(
    '/me/notifications/:id/read',
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await deps.notifications.markRead(auth(res).userId, params.id)),
    ),
  );
  router.delete(
    '/me/notifications/:id',
    handle({ params: idParams }, async ({ params, res }) => {
      await deps.notifications.hide(auth(res).userId, params.id);
      sendOk(res, null, { message: 'Notification removed' });
    }),
  );
  router.get(
    '/me/notification-preferences',
    handle({}, async ({ res }) =>
      sendOk(res, await deps.notifications.preferences(auth(res).userId)),
    ),
  );
  router.put(
    '/me/notification-preferences',
    handle({ body: prefsBody }, async ({ body, res }) =>
      sendOk(res, await deps.notifications.setPreferences(auth(res).userId, body.preferences)),
    ),
  );
  router.post(
    '/me/push-subscriptions',
    handle({ body: pushBody }, async ({ body, res }) =>
      sendOk(res, await deps.notifications.registerPush(auth(res), body), { status: 201 }),
    ),
  );
  router.delete(
    '/me/push-subscriptions/:id',
    handle({ params: idParams }, async ({ params, res }) => {
      await deps.notifications.unregisterPush(auth(res).userId, params.id);
      sendOk(res, null, { message: 'Push notifications turned off for this device' });
    }),
  );
  return router;
}
