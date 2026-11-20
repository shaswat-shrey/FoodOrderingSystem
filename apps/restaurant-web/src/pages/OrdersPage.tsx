import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrderCard, QueueTab } from '@fos/api-client';
import { Alert, Button, EmptyState, Spinner } from '@fos/ui';
import { ServerError } from '../components/fields';
import { useOrderAlert } from '../lib/alert-sound';
import { clock, mmss } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

const TABS: { id: QueueTab; label: string }[] = [
  { id: 'NEW', label: 'New' },
  { id: 'PREPARING', label: 'Preparing' },
  { id: 'READY', label: 'Ready' },
  { id: 'PICKED_UP', label: 'Picked up' },
  { id: 'COMPLETED', label: 'Completed' },
  { id: 'CANCELLED', label: 'Cancelled' },
];
const REJECT = [
  ['ITEM_UNAVAILABLE', 'Item unavailable'],
  ['KITCHEN_BUSY', 'Kitchen too busy'],
  ['CLOSING', 'Closing soon'],
  ['ADDRESS_ISSUE', 'Address problem'],
  ['OTHER', 'Other'],
] as const;
/** Live updates arrive with the realtime gateway (Phase 10); until then the queue polls. */
const POLL_MS = 8_000;

/** FR-RORD-008: order queue with tabs, counts and a repeating alert for new orders. */
export function OrdersPage() {
  const { branchId, can } = useWorkspace();
  const [tab, setTab] = useState<QueueTab>('NEW');
  const counts = useQuery({
    queryKey: ['orders', branchId, 'counts'],
    queryFn: () => merchant.orders.counts(branchId!),
    enabled: Boolean(branchId),
    refetchInterval: POLL_MS,
  });
  const list = useQuery({
    queryKey: ['orders', branchId, tab],
    queryFn: () => merchant.orders.queue(branchId!, tab),
    enabled: Boolean(branchId),
    refetchInterval: POLL_MS,
  });
  const waiting = (counts.data?.NEW ?? 0) > 0;
  const alert = useOrderAlert(waiting);

  if (!branchId) return <EmptyState title="No outlet selected" />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Orders</h1>
        {alert.enabled ? (
          <Button variant="secondary" size="sm" onClick={alert.disable}>
            Mute alerts
          </Button>
        ) : (
          <Button size="sm" onClick={alert.enable}>
            Start receiving orders
          </Button>
        )}
      </div>
      {!alert.enabled && waiting && (
        <Alert tone="warning">
          New orders are waiting. Press “Start receiving orders” to hear the alert.
        </Alert>
      )}
      <div role="tablist" aria-label="Order status" className="flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`h-10 shrink-0 rounded-full px-4 text-sm font-medium ${tab === t.id ? 'bg-brand-700 text-white' : 'bg-white text-gray-700 ring-1 ring-gray-200'}`}
          >
            {t.label} <span className="ml-1 tabular-nums">{counts.data?.[t.id] ?? 0}</span>
          </button>
        ))}
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.data?.length ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.data.map((o) => (
            <li key={o.id}>
              <OrderCardView
                order={o}
                canAccept={can('rest.order:accept')}
                canPrepare={can('rest.order:prepare')}
              />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing here right now" description="New orders appear automatically." />
      )}
    </div>
  );
}

function OrderCardView({
  order,
  canAccept,
  canPrepare,
}: {
  order: OrderCard;
  canAccept: boolean;
  canPrepare: boolean;
}) {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<string>('KITCHEN_BUSY');
  const [note, setNote] = useState('');
  const [prep, setPrep] = useState<number | ''>('');
  const done = () => qc.invalidateQueries({ queryKey: ['orders'] });
  const act = useMutation({
    mutationFn: async (action: 'accept' | 'reject' | 'preparing' | 'ready') => {
      if (action === 'accept')
        return merchant.orders.accept(order.id, prep === '' ? undefined : prep);
      if (action === 'reject')
        return merchant.orders.reject(order.id, {
          reason,
          ...(note ? { note } : {}),
          ...(reason === 'ITEM_UNAVAILABLE' ? { itemIds: [], markUnavailable: false } : {}),
        });
      return action === 'preparing'
        ? merchant.orders.preparing(order.id)
        : merchant.orders.ready(order.id);
    },
    onSuccess: done,
  });
  const left = order.acceptBy ? (new Date(order.acceptBy).getTime() - Date.now()) / 1000 : null;

  return (
    <article
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
      aria-label={`Order ${order.number}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-lg font-semibold">{order.number}</p>
          <p className="text-sm text-gray-600">
            {order.customer} · {order.area ?? '—'} · placed {clock(order.placedAt)}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-xs font-semibold ${order.payment === 'COD' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}
        >
          {order.payment === 'COD' ? 'Cash on delivery' : 'Paid'}
        </span>
      </header>
      <ul className="mt-3 space-y-1 text-sm">
        {order.items.map((i, n) => (
          <li key={n}>
            <span className="font-semibold">{i.quantity} ×</span> {i.name}
            {i.variant ? ` (${i.variant})` : ''}
            {i.options.length > 0 && (
              <span className="text-gray-600"> — {i.options.join(', ')}</span>
            )}
            {i.instructions && (
              <span className="block text-xs text-amber-700">“{i.instructions}”</span>
            )}
          </li>
        ))}
      </ul>
      {order.cookingInstructions && (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-sm text-amber-800">
          Note: {order.cookingInstructions}
        </p>
      )}
      <ServerError error={act.error} />
      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {order.status === 'PLACED' && canAccept && !rejecting && (
          <>
            {left !== null && (
              <span className="text-sm tabular-nums text-danger-600">
                Accept within {mmss(left)}
              </span>
            )}
            <label className="text-sm">
              <span className="sr-only">Prep time (minutes)</span>
              <input
                type="number"
                min={5}
                max={90}
                placeholder="Prep min"
                value={prep}
                onChange={(e) => setPrep(e.target.value === '' ? '' : Number(e.target.value))}
                className="h-11 w-24 rounded-md border border-gray-300 px-2"
              />
            </label>
            <Button loading={act.isPending} onClick={() => act.mutate('accept')}>
              Accept
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </>
        )}
        {rejecting && (
          <div className="w-full space-y-2">
            <select
              aria-label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-2"
            >
              {REJECT.filter(([v]) => v !== 'ITEM_UNAVAILABLE').map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input
              aria-label="Note"
              placeholder="Note (required for Other)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-2"
            />
            <div className="flex gap-2">
              <Button variant="danger" loading={act.isPending} onClick={() => act.mutate('reject')}>
                Confirm reject
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>
                Back
              </Button>
            </div>
          </div>
        )}
        {order.status === 'ACCEPTED' && canPrepare && (
          <Button
            variant="secondary"
            loading={act.isPending}
            onClick={() => act.mutate('preparing')}
          >
            Start preparing
          </Button>
        )}
        {(order.status === 'ACCEPTED' || order.status === 'PREPARING') && canPrepare && (
          <Button loading={act.isPending} onClick={() => act.mutate('ready')}>
            Mark ready
          </Button>
        )}
        {order.readyBy && order.status !== 'PLACED' && (
          <span className="text-sm text-gray-600">Ready by {clock(order.readyBy)}</span>
        )}
      </footer>
    </article>
  );
}
