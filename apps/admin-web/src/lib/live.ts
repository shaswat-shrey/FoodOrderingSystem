import { useQueryClient } from '@tanstack/react-query';
import {
  createRealtime,
  useLiveEvent,
  useLiveReconnect,
  useLiveStatus,
  useLiveSubscription,
  type LiveEnvelope,
} from '@fos/api-client';
import { api } from './api';

/** The admin console's socket (SRS §13); started in main.tsx. */
export const live = createRealtime(api);

export const OPS_EVENTS = [
  'ops.order_activity',
  'ops.partner_stale',
  'ops.approval_requested',
  'support.ticket_updated',
  'restaurant.activity',
];

/** Which cached screens each ops event makes stale. */
const STALE: Record<string, string[][]> = {
  'ops.order_activity': [['dashboard'], ['orders'], ['deliveries']],
  'ops.partner_stale': [['alerts'], ['deliveries']],
  'ops.approval_requested': [['dashboard'], ['restaurant-applications'], ['partner-applications']],
  'support.ticket_updated': [['tickets']],
};

/**
 * Joins the operations room (`admin:ops`) while mounted, refetches what each
 * event touches (and everything after a reconnect), and hands every event to
 * `onEvent` for the activity feed.
 */
export function useOpsLive(onEvent?: (envelope: LiveEnvelope) => void) {
  const qc = useQueryClient();
  useLiveSubscription(live, 'ops', undefined);
  useLiveEvent(live, OPS_EVENTS, (env) => {
    for (const queryKey of STALE[env.event] ?? []) void qc.invalidateQueries({ queryKey });
    onEvent?.(env);
  });
  useLiveReconnect(live, () => void qc.invalidateQueries());
  return useLiveStatus(live);
}
