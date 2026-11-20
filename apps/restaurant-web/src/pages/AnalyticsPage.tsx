import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AnalyticsRange, SalesPoint } from '@fos/api-client';
import { Alert, EmptyState, Spinner } from '@fos/ui';
import { Field, Section, Select, ServerError } from '../components/fields';
import { minutes, rupees } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

const DAY = 86_400_000;
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** IST calendar days → the instants the API expects ([from, to) with `to` exclusive). */
export function toRange(from: string, to: string, branchIds?: string[]): AnalyticsRange {
  return {
    from: new Date(`${from}T00:00:00+05:30`).toISOString(),
    to: new Date(new Date(`${to}T00:00:00+05:30`).getTime() + DAY).toISOString(),
    ...(branchIds ? { branchIds } : {}),
  };
}

function change(now: number, before: number): string {
  if (!before) return now ? 'new this period' : 'no change';
  const pct = Math.round(((now - before) / before) * 1000) / 10;
  return `${pct >= 0 ? '+' : ''}${pct}% vs previous period`;
}

/** FR-RANL-002…004: sales over a range, top dishes, categories and operations, from real orders. */
export function AnalyticsPage() {
  const { restaurant, branchId, can } = useWorkspace();
  const today = istDay(new Date());
  const [from, setFrom] = useState(istDay(new Date(Date.now() - 6 * DAY)));
  const [to, setTo] = useState(today);
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('day');
  const [scope, setScope] = useState<'all' | 'outlet'>('all');
  const rid = restaurant?.id ?? '';
  const valid = Boolean(from && to && from <= to);
  const range = valid
    ? toRange(from, to, scope === 'outlet' && branchId ? [branchId] : undefined)
    : null;
  const enabled = Boolean(rid && range && can('rest.analytics:read'));
  const key = ['analytics', rid, range];
  const sales = useQuery({
    queryKey: [...key, 'sales', granularity],
    queryFn: () => merchant.analytics.sales(rid, { ...range!, granularity }),
    enabled,
  });
  const items = useQuery({
    queryKey: [...key, 'items'],
    queryFn: () => merchant.analytics.items(rid, range!),
    enabled,
  });
  const categories = useQuery({
    queryKey: [...key, 'categories'],
    queryFn: () => merchant.analytics.categories(rid, range!),
    enabled,
  });
  const ops = useQuery({
    queryKey: [...key, 'operations'],
    queryFn: () => merchant.analytics.operations(rid, range!),
    enabled,
  });
  if (!restaurant) return null;
  if (!can('rest.analytics:read'))
    return <EmptyState title="Ask your manager for access to analytics" />;
  const s = sales.data;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Analytics</h1>
      <form
        className="grid items-end gap-2 rounded-xl border border-gray-200 bg-white p-4 md:grid-cols-4"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Report range"
      >
        <Field
          label="From"
          type="date"
          max={today}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Field
          label="To"
          type="date"
          max={today}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <Select
          label="Group by"
          value={granularity}
          onChange={(e) => setGranularity(e.target.value as typeof granularity)}
        >
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </Select>
        <Select
          label="Outlets"
          value={scope}
          onChange={(e) => setScope(e.target.value as typeof scope)}
        >
          <option value="all">All my outlets</option>
          <option value="outlet">Selected outlet only</option>
        </Select>
      </form>
      {!valid && <Alert tone="error">The start date must be on or before the end date.</Alert>}
      <ServerError error={sales.error ?? items.error ?? categories.error ?? ops.error} />

      {s ? (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Stat
              label="Revenue (delivered)"
              value={rupees(s.totals.revenue)}
              note={change(s.totals.revenue, s.previousTotals.revenue)}
            />
            <Stat
              label="Orders"
              value={String(s.totals.orders)}
              note={change(s.totals.orders, s.previousTotals.orders)}
            />
            <Stat
              label="Delivered"
              value={String(s.totals.delivered)}
              note={change(s.totals.delivered, s.previousTotals.delivered)}
            />
          </div>
          <Section title={`Revenue by ${granularity}`}>
            {s.series.length === 0 ? (
              <p className="text-sm text-gray-600">No orders in this period.</p>
            ) : (
              <SalesChart series={s.series} title={`Revenue by ${granularity}`} />
            )}
          </Section>
        </>
      ) : (
        valid && <Spinner />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Top dishes">
          {items.data && (
            <Bars
              label="Top dishes by quantity"
              rows={items.data.slice(0, 10).map((i) => ({
                key: i.foodItemId,
                name: i.name,
                value: i.quantity,
                text: `${i.quantity} sold · ${rupees(i.revenue)}`,
              }))}
            />
          )}
        </Section>
        <Section title="Categories">
          {categories.data && (
            <Bars
              label="Revenue by category"
              rows={categories.data.map((c) => ({
                key: c.categoryId,
                name: c.name,
                value: c.revenue,
                text: `${rupees(c.revenue)} · ${c.quantity} items`,
              }))}
            />
          )}
        </Section>
      </div>

      {ops.data && (
        <Section title="Operations">
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <Metric label="Orders" value={String(ops.data.orders)} />
            <Metric label="Accepted" value={`${ops.data.acceptanceRate}%`} />
            <Metric label="Rejected" value={`${ops.data.rejectionRate}%`} />
            <Metric label="Missed (timed out)" value={`${ops.data.timeoutRate}%`} />
            <Metric label="Cancelled by you" value={`${ops.data.restaurantCancellationRate}%`} />
            <Metric label="Ready late" value={`${ops.data.lateReadyRate}%`} />
            <Metric label="Avg time to accept" value={minutes(ops.data.avgAcceptSeconds)} />
            <Metric label="Avg prep time" value={minutes(ops.data.avgPrepSeconds)} />
          </dl>
        </Section>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm text-gray-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-gray-600">{note}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-gray-600">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** Inline SVG column chart; each bar has a title, and a table carries the same numbers. */
export function SalesChart({ series, title }: { series: SalesPoint[]; title: string }) {
  const W = 640;
  const H = 200;
  const max = Math.max(1, ...series.map((p) => p.revenue));
  const slot = W / series.length;
  const bar = Math.max(4, Math.min(48, slot * 0.7));
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H + 24}`}
        role="img"
        aria-label={`${title}: ${series.length} bars, highest ${rupees(max)}`}
        className="h-56 w-full"
      >
        <line x1={0} y1={H} x2={W} y2={H} stroke="currentColor" className="text-gray-300" />
        {series.map((p, i) => {
          const h = Math.round((p.revenue / max) * (H - 10));
          const x = i * slot + (slot - bar) / 2;
          return (
            <g key={p.bucket} data-testid="sales-bar">
              <rect x={x} y={H - h} width={bar} height={h} rx={3} className="fill-brand-700">
                <title>{`${p.bucket}: ${rupees(p.revenue)} from ${p.delivered} delivered orders`}</title>
              </rect>
              {series.length <= 14 && (
                <text
                  x={x + bar / 2}
                  y={H + 16}
                  textAnchor="middle"
                  className="fill-gray-600 text-[11px]"
                >
                  {p.bucket.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-brand-700">Show as a table</summary>
        <table className="mt-2 w-full text-left">
          <thead>
            <tr className="text-gray-600">
              <th scope="col">Period</th>
              <th scope="col">Orders</th>
              <th scope="col">Delivered</th>
              <th scope="col">Revenue</th>
              <th scope="col">Avg order</th>
              <th scope="col">New / repeat customers</th>
            </tr>
          </thead>
          <tbody>
            {series.map((p) => (
              <tr key={p.bucket} className="border-t border-gray-100">
                <th scope="row" className="font-normal">
                  {p.bucket}
                </th>
                <td>{p.orders}</td>
                <td>{p.delivered}</td>
                <td>{rupees(p.revenue)}</td>
                <td>{rupees(p.averageOrderValue)}</td>
                <td>
                  {p.newCustomers} / {p.repeatCustomers}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Horizontal bars as a list: the text carries the numbers, the bar is decoration. */
function Bars({
  label,
  rows,
}: {
  label: string;
  rows: { key: string; name: string; value: number; text: string }[];
}) {
  if (rows.length === 0) return <p className="text-sm text-gray-600">Nothing delivered yet.</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="text-sm">
          <div className="flex justify-between gap-2">
            <span className="font-medium">{r.name}</span>
            <span className="tabular-nums text-gray-700">{r.text}</span>
          </div>
          <div aria-hidden="true" className="mt-1 h-2 rounded bg-gray-100">
            <div
              className="h-2 rounded bg-brand-700"
              style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
