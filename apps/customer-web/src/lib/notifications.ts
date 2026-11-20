import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@fos/auth-web';
import { useLiveEvent } from '@fos/api-client';
import { customer } from './customer';
import { live } from './live';

export const notificationsKey = ['notifications'] as const;
export const unreadKey = [...notificationsKey, 'unread'] as const;

/**
 * Unread inbox count for the header badge (API-NTF-002). A pushed
 * `notification.created` bumps it at once and refreshes the inbox.
 */
export function useUnreadCount() {
  const qc = useQueryClient();
  const signedIn = useAuth().status === 'signedIn';
  const query = useQuery({
    queryKey: unreadKey,
    queryFn: () => customer.notifications.unreadCount(),
    enabled: signedIn,
    refetchInterval: 120_000,
  });
  useLiveEvent(live, 'notification.created', () => {
    if (!signedIn) return;
    qc.setQueryData<{ unread: number }>(unreadKey, (c) => ({ unread: (c?.unread ?? 0) + 1 }));
    void qc.invalidateQueries({ queryKey: [...notificationsKey, 'inbox'] });
  });
  return signedIn ? (query.data?.unread ?? 0) : 0;
}
