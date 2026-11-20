import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { AdminAlert, LiveEnvelope, LiveStatus } from '@fos/api-client';
import { cn } from '@fos/ui';
import {
  ActionDialog,
  Badge,
  Empty,
  Field,
  Loader,
  PageHeader,
  Section,
  Stat,
} from '../components/ui';
import { admin } from '../lib/admin';
import { dateTime, label, rupees } from '../lib/format';
import { useOpsLive } from '../lib/live';
import { usePermissions } from '../lib/permissions';

const FEED_MAX = 50;

const STATUS_TEXT: Record<LiveStatus, { text: string; tone: string }> = {
  connected: { text: 'Live', tone: 'bg-green-500' },
  connecting: { text: 'Connecting…', tone: 'bg-amber-400' },
  disconnected: { text: 'Offline — refreshing every 30 s', tone: 'bg-red-500' },
  idle: { text: 'Not connected', tone: 'bg-gray-400' },
};

function describe(env: LiveEnvelope): { text: string; to?: string } {
  const d = env.data as Record<string, string | null | undefined>;
  switch (env.event) {
    case 'ops.order_activity':
      return { text: `Order ${d.number ?? ''} → ${label(d.status)}`, to: `/orders/${d.orderId}` };
    case 'ops.partner_stale':
      return {
        text: 'A partner on a delivery stopped sending location',
        to: d.partnerId ? `/partners/${d.partnerId}` : undefined,
      };
    case 'ops.approval_requested':
      return {
        text: `New ${label(d.type).toLowerCase()} awaiting approval`,
        to: d.type === 'RESTAURANT_CHANGE' ? '/change-requests' : '/approvals',
      };
    case 'support.ticket_updated':
      return { text: `Ticket ${label(d.change).toLowerCase()}`, to: `/support/${d.ticketId}` };
    default:
      return { text: label(env.event.replace('.', '_')) };
  }
}

function AlertRow({ alert }: { alert: AdminAlert }) {
  const [note, setNote] = useState('');
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge value={alert.severity} />
          <span className="text-xs text-gray-500">{label(alert.type)}</span>
          <span className="text-xs text-gray-500">{dateTime(alert.createdAt)}</span>
          {alert.status !== 'OPEN' && <Badge value={alert.status} />}
        </div>
        <p className="mt-1 text-sm text-gray-900">{alert.message}</p>
      </div>
      <div className="flex gap-2">
        {alert.status === 'OPEN' && (
          <ActionDialog
            label="Acknowledge"
            title="Acknowledge alert"
            description="Tells the team someone is on it."
            reason="none"
            confirmLabel="Acknowledge"
            onConfirm={() => admin.alerts.acknowledge(alert.id, note ? { note } : {})}
          >
            <Field label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          </ActionDialog>
        )}
        <ActionDialog
          label="Resolve"
          title="Resolve alert"
          reason="none"
          confirmLabel="Resolve"
          onConfirm={() =>
            admin.alerts.acknowledge(alert.id, { resolve: true, ...(note ? { note } : {}) })
          }
        >
          <Field label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        </ActionDialog>
      </div>
    </li>
  );
}

export function DashboardPage() {
  const { can } = usePermissions();
  const [feed, setFeed] = useState<LiveEnvelope[]>([]);
  const status = useOpsLive((env) => setFeed((f) => [env, ...f].slice(0, FEED_MAX)));
  const poll = status === 'connected' ? 120_000 : 30_000;
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => admin.dashboard(),
    refetchInterval: poll,
  });
  const alerts = useQuery({
    queryKey: ['alerts', 'dashboard'],
    queryFn: () => admin.alerts.list({ pageSize: 20 }),
    refetchInterval: poll,
    enabled: can('ops:monitor'),
  });
  const s = STATUS_TEXT[status];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Today on the platform (India time)."
        actions={
          <span className="flex items-center gap-2 text-sm text-gray-700" aria-live="polite">
            <span className={cn('h-2.5 w-2.5 rounded-full', s.tone)} aria-hidden />
            {s.text}
          </span>
        }
      />
      <Loader query={dashboard}>
        {(d) => (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Active orders" value={d.orders.activeTotal} />
            <Stat label="Delivered today" value={d.orders.completedToday} />
            <Stat
              label="Cancelled / failed today"
              value={`${d.orders.cancelledToday + d.orders.rejectedToday} / ${d.orders.failedToday}`}
            />
            <Stat label="GMV today" value={rupees(d.gmv.today)} hint={`${d.gmv.orders} orders`} />
            <Stat
              label="Platform revenue today"
              value={rupees(d.platformRevenue.today)}
              hint={`Commission ${rupees(d.platformRevenue.commission)} · fees ${rupees(d.platformRevenue.fees)}`}
            />
            <Stat
              label="Restaurants open now"
              value={`${d.restaurants.activeNow} / ${d.restaurants.total}`}
            />
            <Stat
              label="Partners online"
              value={d.partners.onlineNow}
              hint={`${d.partners.onDelivery} on delivery`}
            />
            <Stat
              label="Pending approvals"
              value={d.restaurants.pendingApprovals + d.partners.pendingApprovals}
              hint={`${d.restaurants.pendingApprovals} restaurants · ${d.partners.pendingApprovals} partners`}
            />
            <Stat
              label="Refunds today"
              value={rupees(d.refunds.createdAmountToday)}
              hint={`${d.refunds.createdToday} created · ${d.refunds.pending} pending`}
            />
            <Stat
              label="Payouts pending"
              value={rupees(d.payouts.pendingAmount)}
              hint={`${d.payouts.pendingLines} lines · ${d.payouts.draftBatches} draft batches`}
            />
            <Stat
              label="New users today"
              value={d.users.newToday}
              hint={`${d.users.total} total`}
            />
            <Stat
              label="Open alerts"
              value={d.alerts.open}
              hint={`${d.alerts.bySeverity.CRITICAL} critical · ${d.alerts.unassignedDeliveries} unassigned deliveries`}
            />
          </div>
        )}
      </Loader>

      <div className="grid gap-6 lg:grid-cols-2">
        {can('ops:monitor') && (
          <Section title="Open alerts">
            <Loader query={alerts}>
              {(page) =>
                page.data.length === 0 ? (
                  <Empty>No open alerts.</Empty>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {page.data.map((a) => (
                      <AlertRow key={a.id} alert={a} />
                    ))}
                  </ul>
                )
              }
            </Loader>
          </Section>
        )}
        <Section title="Live activity">
          {feed.length === 0 ? (
            <Empty>Order, approval and support activity appears here as it happens.</Empty>
          ) : (
            <ul className="divide-y divide-gray-100 text-sm" aria-live="polite">
              {feed.map((env) => {
                const { text, to } = describe(env);
                return (
                  <li
                    key={`${env.eventId}:${env.event}`}
                    className="flex justify-between gap-3 py-1.5"
                  >
                    {to ? (
                      <Link to={to} className="text-brand-700 hover:underline">
                        {text}
                      </Link>
                    ) : (
                      <span>{text}</span>
                    )}
                    <span className="shrink-0 text-xs text-gray-500">
                      {dateTime(env.occurredAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
