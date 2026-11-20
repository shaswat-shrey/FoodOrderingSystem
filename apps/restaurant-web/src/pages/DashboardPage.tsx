import { useQuery } from '@tanstack/react-query';
import { EmptyState, Spinner } from '@fos/ui';
import { minutes, rupees } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm text-gray-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** FR-RANL-001: today at a glance, from real orders only. */
export function DashboardPage() {
  const { restaurant, can } = useWorkspace();
  const q = useQuery({
    queryKey: ['dashboard', restaurant?.id],
    queryFn: () => merchant.dashboard(restaurant!.id),
    enabled: Boolean(restaurant && can('rest.analytics:read')),
    refetchInterval: 30_000,
  });
  if (!restaurant) return null;
  if (!can('rest.analytics:read'))
    return <EmptyState title="Ask your manager for access to the dashboard" />;
  if (q.isLoading || !q.data) return <Spinner />;
  const d = q.data;
  const total = Object.values(d.orders).reduce((s, n) => s + n, 0);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Today at {restaurant.name}</h1>
      {total === 0 && (
        <EmptyState title="No orders yet today" description="Numbers appear as orders come in." />
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="New" value={String(d.orders.new)} />
        <Stat label="In the kitchen" value={String(d.orders.preparing + d.orders.ready)} />
        <Stat label="Delivered" value={String(d.orders.delivered)} />
        <Stat label="Cancelled / rejected" value={String(d.orders.cancelled + d.orders.rejected)} />
        <Stat label="Food value" value={rupees(d.revenue.foodValue)} />
        <Stat label="Net payable (settled)" value={rupees(d.revenue.netPayable)} />
        <Stat label="Average order" value={rupees(d.averageOrderValue)} />
        <Stat
          label="Acceptance rate"
          value={d.acceptanceRate == null ? '—' : `${d.acceptanceRate}%`}
        />
        <Stat label="Avg time to accept" value={minutes(d.avgAcceptSeconds)} />
        <Stat label="Avg prep time" value={minutes(d.avgPrepSeconds)} />
        <Stat
          label="Rating"
          value={
            d.rating ? `${d.rating.average.toFixed(1)} ★ (${d.rating.count})` : 'No ratings yet'
          }
        />
      </div>
    </div>
  );
}
