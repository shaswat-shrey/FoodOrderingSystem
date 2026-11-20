import { useQueryClient } from '@tanstack/react-query';
import {
  createRealtime,
  useLiveEvent,
  useLiveReconnect,
  useLiveStatus,
  useLiveSubscription,
} from '@fos/api-client';
import { api } from './api';

/** The restaurant app's socket (SRS §13); started in main.tsx. */
export const live = createRealtime(api);

const ORDER_EVENTS = [
  'order.new',
  'order.updated',
  'order.cancelled',
  'order.accept_reminder',
  'delivery.partner_assigned',
  'delivery.partner_arrived',
  'delivery.picked_up',
];

/**
 * Keeps a branch screen fresh: joins the branch room, refetches on its events and
 * after reconnects, and tells the caller how often to poll as a fallback
 * (FR-RT-022: every 15 s while the socket is down, rarely while it is up).
 */
export function useBranchLive(branchId: string | null, room: 'branch-orders' | 'branch-kds') {
  const qc = useQueryClient();
  const keys = room === 'branch-kds' ? [['kds']] : [['orders'], ['kds']];
  const refresh = () => keys.forEach((queryKey) => void qc.invalidateQueries({ queryKey }));
  useLiveSubscription(live, room, branchId);
  useLiveEvent(live, ORDER_EVENTS, refresh);
  useLiveEvent(
    live,
    'branch.status_changed',
    () => void qc.invalidateQueries({ queryKey: ['branch'] }),
  );
  useLiveReconnect(live, refresh);
  const status = useLiveStatus(live);
  return { status, pollMs: status === 'connected' ? 60_000 : 15_000 };
}
