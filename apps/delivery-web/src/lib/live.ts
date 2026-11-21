import { useQueryClient } from '@tanstack/react-query';
import { createRealtime, useLiveEvent, useLiveReconnect, useLiveStatus } from '@fos/api-client';
import { api } from './api';

/** The partner app's socket (SRS §13); started in main.tsx. */
export const live = createRealtime(api);

const EVENTS: Record<string, string[][]> = {
  'offer.created': [
    ['partner', 'offer'],
    ['partner', 'availability'],
  ],
  'offer.expired': [
    ['partner', 'offer'],
    ['partner', 'availability'],
  ],
  'offer.withdrawn': [
    ['partner', 'offer'],
    ['partner', 'availability'],
  ],
  'assignment.confirmed': [['partner']],
  'assignment.revoked': [['partner']],
  'partner.status_changed': [['partner', 'availability']],
  'earnings.updated': [
    ['partner', 'dashboard'],
    ['partner', 'earnings'],
    ['partner', 'statement'],
  ],
  'order.ready': [['partner', 'delivery']],
  'order.cancelled': [['partner']],
  'order.prep_delayed': [['partner', 'delivery']],
  'delivery.status_changed': [
    ['partner', 'delivery'],
    ['partner', 'availability'],
  ],
};

/**
 * Refetches what each pushed event changes (EVT-DP-001…016) and everything after
 * a reconnect; returns the fallback polling interval (fast while disconnected).
 */
export function usePartnerLive() {
  const qc = useQueryClient();
  useLiveEvent(live, Object.keys(EVENTS), (env) => {
    for (const queryKey of EVENTS[env.event] ?? []) void qc.invalidateQueries({ queryKey });
  });
  useLiveReconnect(live, () => void qc.invalidateQueries({ queryKey: ['partner'] }));
  const status = useLiveStatus(live);
  return { status, connected: status === 'connected' };
}
