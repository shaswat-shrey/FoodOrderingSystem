import type { ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { CustomerOrderSummary, OrderHistoryFilter } from '@fos/api-client';
import { Button, EmptyState, ErrorState, Spinner, cn } from '@fos/ui';
import { LoadMore, PageTitle } from '../components/account-ui';
import { customer } from '../lib/customer';
import { dayTime, rupees } from '../lib/format';
import { useReorder } from '../lib/reorder';

const TABS: { key: OrderHistoryFilter | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'DELIVERED', label: 'Delivered' },
  { key: 'CANCELLED', label: 'Cancelled' },
];
const ACTIVE = new Set([
  'PAYMENT_PENDING',
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
]);

/** Order history with status filters and cursor paging (FR-CORD-002, API-ORD-001). */
export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('status'))?.key ?? 'ALL') as
    OrderHistoryFilter | 'ALL';
  const status = tab === 'ALL' ? undefined : tab;
  const orders = useInfiniteQuery({
    queryKey: ['orders', 'history', tab],
    queryFn: ({ pageParam }) =>
      customer.orders.history({ status, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const { reorder, busy, outcome, prompt } = useReorder();
  const rows = orders.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div>
      <PageTitle>Your orders</PageTitle>
      <div role="tablist" aria-label="Filter orders" className="mb-4 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={cn(
              'h-11 shrink-0 rounded-full border px-4 text-sm',
              tab === t.key
                ? 'border-brand-700 bg-brand-50 font-semibold text-brand-800'
                : 'border-gray-300 text-gray-700',
            )}
            onClick={() => setParams(t.key === 'ALL' ? {} : { status: t.key }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>
      {orders.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner label="Loading orders" />
        </div>
      ) : orders.isError ? (
        <ErrorState
          title="Couldn’t load your orders"
          description={orders.error.message}
          action={<Button onClick={() => void orders.refetch()}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No orders here yet"
          description="When you order, it shows up here."
          action={
            <Link to="/" className="font-medium text-brand-700 underline">
              Find something to eat
            </Link>
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Orders">
          {rows.map((o) => (
            <OrderRow
              key={o.id}
              order={o}
              busy={busy === o.id}
              onReorder={() => void reorder(o.id)}
              outcome={outcome(o.id)}
            />
          ))}
        </ul>
      )}
      <LoadMore
        hasMore={Boolean(orders.hasNextPage)}
        loading={orders.isFetchingNextPage}
        onClick={() => void orders.fetchNextPage()}
      />
      {prompt}
    </div>
  );
}

function OrderRow({
  order: o,
  busy,
  onReorder,
  outcome,
}: {
  order: CustomerOrderSummary;
  busy: boolean;
  onReorder: () => void;
  outcome: ReactNode;
}) {
  const active = ACTIVE.has(o.status);
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`/orders/${o.id}`}
            className="font-semibold text-gray-900 hover:text-brand-700 hover:underline"
          >
            {o.restaurant.name}
          </Link>
          <p className="text-xs text-gray-500">
            {o.restaurant.branchName} · {o.number} · {dayTime(o.placedAt ?? o.createdAt)}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
            active
              ? 'bg-brand-50 text-brand-800'
              : o.status === 'DELIVERED'
                ? 'bg-green-50 text-success-600'
                : 'bg-gray-100 text-gray-700',
          )}
        >
          {o.statusLabel}
        </span>
      </div>
      <p className="mt-2 truncate text-sm text-gray-700">{o.itemsSummary}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="font-semibold tabular-nums">{rupees(o.totalAmount)}</span>
        <div className="flex gap-2">
          {active ? (
            <Link
              to={`/orders/${o.id}`}
              className="inline-flex h-9 items-center rounded-lg bg-brand-700 px-3 text-sm font-medium text-white hover:bg-brand-800"
            >
              Track order
            </Link>
          ) : (
            <>
              <Link
                to={`/orders/${o.id}`}
                className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-900 hover:bg-gray-50"
                aria-label={`Details of order ${o.number}`}
              >
                Details
              </Link>
              <Button
                size="sm"
                loading={busy}
                onClick={onReorder}
                aria-label={`Reorder ${o.number}`}
              >
                Reorder
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="mt-2 space-y-2 empty:hidden">{outcome}</div>
    </li>
  );
}
