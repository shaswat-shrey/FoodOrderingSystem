import { useState } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { InboxNotification } from '@fos/api-client';
import { Button, EmptyState, ErrorState, Spinner, cn } from '@fos/ui';
import { LoadMore, PageTitle } from '../components/account-ui';
import { ServerError } from '../components/ui';
import { customer } from '../lib/customer';
import { dayTime } from '../lib/format';
import { notificationsKey, unreadKey } from '../lib/notifications';

type Pages = InfiniteData<{ data: InboxNotification[]; nextCursor: string | null }>;
const inboxKey = [...notificationsKey, 'inbox'];

/** Only in-app paths are followed; anything else stays on the inbox. */
const internal = (link: string | null) =>
  link && link.startsWith('/') && !link.startsWith('//') ? link : null;

/** Notification inbox with unread state (API-NTF-001…004). */
export function NotificationsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inbox = useInfiniteQuery({
    queryKey: inboxKey,
    queryFn: ({ pageParam }) => customer.notifications.list(pageParam ? { cursor: pageParam } : {}),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const rows = inbox.data?.pages.flatMap((p) => p.data) ?? [];
  const anyUnread = rows.some((n) => !n.read);

  const markLocal = (pred: (n: InboxNotification) => boolean) =>
    qc.setQueryData<Pages>(inboxKey, (d) =>
      d
        ? {
            ...d,
            pages: d.pages.map((p) => ({
              ...p,
              data: p.data.map((n) => (pred(n) ? { ...n, read: true } : n)),
            })),
          }
        : d,
    );

  async function markAll() {
    setBusy(true);
    setError(null);
    try {
      await customer.notifications.markAllRead();
      markLocal(() => true);
      qc.setQueryData(unreadKey, { unread: 0 });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function open(n: InboxNotification) {
    if (!n.read) {
      try {
        await customer.notifications.markRead(n.id);
        markLocal((x) => x.id === n.id);
        qc.setQueryData<{ unread: number }>(unreadKey, (c) => ({
          unread: Math.max(0, (c?.unread ?? 1) - 1),
        }));
      } catch (e) {
        setError(e);
      }
    }
    const to = internal(n.deepLink);
    if (to) navigate(to);
  }

  return (
    <div>
      <PageTitle
        aside={
          anyUnread && (
            <Button variant="secondary" size="sm" loading={busy} onClick={() => void markAll()}>
              Mark all as read
            </Button>
          )
        }
      >
        Notifications
      </PageTitle>
      <ServerError error={error} />
      {inbox.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner label="Loading notifications" />
        </div>
      ) : inbox.isError ? (
        <ErrorState
          title="Couldn’t load notifications"
          description={inbox.error.message}
          action={<Button onClick={() => void inbox.refetch()}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="You’re all caught up"
          description="Order updates and offers land here."
        />
      ) : (
        <ul className="space-y-2" aria-label="Notifications">
          {rows.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => void open(n)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-xl border p-3 text-left',
                  n.read ? 'border-gray-200 bg-white' : 'border-brand-200 bg-brand-50',
                )}
                aria-label={`${n.read ? '' : 'Unread: '}${n.title}`}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    n.read ? 'bg-transparent' : 'bg-brand-700',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-gray-900">{n.title}</span>
                  <span className="block text-sm text-gray-700">{n.body}</span>
                  <span className="block text-xs text-gray-500">{dayTime(n.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <LoadMore
        hasMore={Boolean(inbox.hasNextPage)}
        loading={inbox.isFetchingNextPage}
        onClick={() => void inbox.fetchNextPage()}
      />
    </div>
  );
}
