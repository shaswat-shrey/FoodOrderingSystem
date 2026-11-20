import type { Realtime } from '../../platform/realtime/publisher';
import type { DispatchService } from '../dispatch';
import type { NotificationService } from '../notifications';
import type { PartnerAvailabilityService } from '../partners';
import type { LiveTracking } from './live-tracking';

/** Hooks that turn non-outbox changes into pushes (offers closing, auto-offline, inbox, tracking). */
export function wireRealtime(deps: {
  realtime: Realtime;
  dispatch: DispatchService;
  partnerAvailability: PartnerAvailabilityService;
  notifications: NotificationService;
  liveTracking: LiveTracking;
}) {
  const { realtime, dispatch, partnerAvailability, notifications, liveTracking } = deps;
  dispatch.onOfferClosed = (partnerId, offerId, reason) =>
    realtime.push({
      app: 'DELIVERY',
      rooms: [`partner:${partnerId}`],
      event: reason === 'EXPIRED' ? 'offer.expired' : 'offer.withdrawn',
      aggregate: { type: 'offer', id: offerId, version: 0 },
      data: { offerId, ...(reason === 'EXPIRED' ? {} : { reason }) },
    });
  partnerAvailability.onOffline = (partnerId, reason) =>
    realtime.push({
      app: 'DELIVERY',
      rooms: [`partner:${partnerId}`],
      event: 'partner.status_changed',
      aggregate: { type: 'partner', id: partnerId, version: 0 },
      data: { state: 'OFFLINE', reason },
    });
  partnerAvailability.onLocation = (partnerId, deliveryId, fix) =>
    liveTracking.onLocation(partnerId, deliveryId, fix);
  notifications.onInApp = (n) =>
    realtime.push({
      app: n.app as 'CUSTOMER' | 'RESTAURANT' | 'DELIVERY' | 'ADMIN',
      rooms: [`user:${n.userId}`],
      event: 'notification.created',
      aggregate: { type: 'notification', id: n.id, version: 0 },
      data: {
        id: n.id,
        title: n.title,
        body: n.body,
        category: n.category,
        deepLink: n.deepLink,
      },
    });
}
