import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KdsTicket } from '@fos/api-client';
import { Button, EmptyState } from '@fos/ui';
import { mmss } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useBranchLive } from '../lib/live';
import { useWorkspace } from '../lib/workspace';

const COLUMNS: { status: KdsTicket['status']; title: string }[] = [
  { status: 'ACCEPTED', title: 'To start' },
  { status: 'PREPARING', title: 'Cooking' },
  { status: 'READY_FOR_PICKUP', title: 'Ready' },
];
const URGENCY = {
  GREEN: 'border-green-500',
  AMBER: 'border-amber-500',
  RED: 'border-red-600 bg-red-50',
} as const;

/** FR-RORD-010: kitchen display — no prices or customer details, big touch targets. */
export function KitchenPage() {
  const { branchId, can } = useWorkspace();
  const qc = useQueryClient();
  const { pollMs } = useBranchLive(branchId, 'branch-kds');
  const tickets = useQuery({
    queryKey: ['kds', branchId],
    queryFn: () => merchant.orders.kds(branchId!),
    enabled: Boolean(branchId),
    refetchInterval: pollMs,
    // Keep showing the last state while offline (FR-RORD-010).
    placeholderData: (prev) => prev,
  });
  const bump = useMutation({
    mutationFn: (t: KdsTicket) =>
      t.status === 'ACCEPTED' ? merchant.orders.preparing(t.id) : merchant.orders.ready(t.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kds'] }),
  });
  if (!branchId) return <EmptyState title="No outlet selected" />;
  const offline = tickets.isError;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Kitchen</h1>
        {offline && (
          <span
            role="status"
            className="rounded-full bg-red-600 px-3 py-1 text-sm font-semibold text-white"
          >
            Offline — showing last update
          </span>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {COLUMNS.map((col) => {
          const list = (tickets.data ?? []).filter((t) => t.status === col.status);
          return (
            <section key={col.status} aria-label={col.title} className="rounded-xl bg-gray-100 p-2">
              <h2 className="px-1 pb-2 text-sm font-semibold uppercase text-gray-600">
                {col.title} ({list.length})
              </h2>
              <ul className="space-y-2">
                {list.map((t) => (
                  <li
                    key={t.id}
                    className={`rounded-lg border-l-8 bg-white p-3 shadow-sm ${URGENCY[t.urgency]}`}
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-xl font-bold">{t.number.slice(-6)}</span>
                      <span className="tabular-nums text-sm text-gray-700">
                        {mmss(t.elapsedSeconds)}
                      </span>
                    </div>
                    <ul className="mt-2 text-base">
                      {t.items.map((i, n) => (
                        <li key={n}>
                          <strong>{i.quantity}×</strong> {i.name}
                          {i.variant ? ` (${i.variant})` : ''}
                          {i.options.length > 0 && (
                            <span className="block text-sm text-gray-600">
                              {i.options.join(', ')}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {t.cookingInstructions && (
                      <p className="mt-1 text-sm text-amber-700">{t.cookingInstructions}</p>
                    )}
                    {t.status !== 'READY_FOR_PICKUP' && can('rest.order:prepare') && (
                      <Button
                        className="mt-3 w-full"
                        size="lg"
                        loading={bump.isPending && bump.variables?.id === t.id}
                        onClick={() => bump.mutate(t)}
                      >
                        {t.status === 'ACCEPTED' ? 'Start' : 'Ready'}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
