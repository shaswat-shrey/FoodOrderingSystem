import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { AdminDeliveryRow } from '@fos/api-client';
import { cn } from '@fos/ui';
import {
  ActionDialog,
  Badge,
  Empty,
  Field,
  Filters,
  Loader,
  Options,
  PageHeader,
  Pager,
  Select,
  Table,
} from '../components/ui';
import { admin } from '../lib/admin';
import { dateTime, label } from '../lib/format';
import { useOpsLive } from '../lib/live';

const STATUSES = [
  'PENDING',
  'SEARCHING',
  'ASSIGNED',
  'AT_RESTAURANT',
  'EN_ROUTE_TO_CUSTOMER',
  'AT_CUSTOMER',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
];

function Candidates({ d }: { d: AdminDeliveryRow }) {
  const [force, setForce] = useState(false);
  const q = useQuery({
    queryKey: ['deliveries', d.id, 'candidates'],
    queryFn: () => admin.deliveries.candidates(d.id),
  });
  const reassign = Boolean(d.partner);
  return (
    <Loader query={q}>
      {(list) =>
        list.length === 0 ? (
          <Empty>No eligible partners nearby right now.</Empty>
        ) : (
          <Table head={['#', 'Partner', 'Distance', 'ETA', 'Acceptance', 'Rating', 'Today', '']}>
            {list.map((c) => (
              <tr key={c.partnerId}>
                <td>{c.rank}</td>
                <td>
                  <Link className="text-brand-700 hover:underline" to={`/partners/${c.partnerId}`}>
                    {c.name ?? c.partnerId.slice(0, 8)}
                  </Link>
                  <div className="text-xs text-gray-500">{c.phone}</div>
                </td>
                <td>{(c.distanceM / 1000).toFixed(1)} km</td>
                <td>{c.etaMinutes} min</td>
                <td>{c.acceptanceRate == null ? '—' : `${Math.round(c.acceptanceRate * 100)}%`}</td>
                <td>{c.rating ?? '—'}</td>
                <td>{c.deliveriesToday}</td>
                <td>
                  <ActionDialog
                    label={reassign ? 'Reassign' : 'Assign'}
                    variant="primary"
                    title={`${reassign ? 'Reassign' : 'Assign'} ${c.name ?? 'partner'} to ${d.order.number}`}
                    confirmLabel={reassign ? 'Reassign' : 'Assign'}
                    onConfirm={(reason) =>
                      (reassign ? admin.deliveries.reassign : admin.deliveries.assign)(d.id, {
                        partnerId: c.partnerId,
                        force,
                        reason,
                      })
                    }
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={force}
                        onChange={(e) => setForce(e.target.checked)}
                      />
                      Override soft checks (cash cap, distance)
                    </label>
                  </ActionDialog>
                </td>
              </tr>
            ))}
          </Table>
        )
      }
    </Loader>
  );
}

export function DispatchPage() {
  const status = useOpsLive();
  const [filter, setFilter] = useState('');
  const [escalated, setEscalated] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [minutes, setMinutes] = useState('15');
  const q = useQuery({
    queryKey: ['deliveries', filter, escalated, page],
    queryFn: () =>
      admin.deliveries.list({
        status: filter || undefined,
        escalated: escalated === '' ? undefined : escalated === 'true',
        page,
      }),
    refetchInterval: status === 'connected' ? 60_000 : 15_000,
  });
  return (
    <div>
      <PageHeader title="Dispatch board" subtitle="Escalated deliveries first, then oldest." />
      <Filters>
        <Select label="Status" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <Options values={STATUSES} any="All in progress" />
        </Select>
        <Select label="Escalation" value={escalated} onChange={(e) => setEscalated(e.target.value)}>
          <option value="">All</option>
          <option value="true">Escalated only</option>
          <option value="false">Not escalated</option>
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No deliveries in progress.</Empty>
          ) : (
            <>
              <Table head={['Order', 'Restaurant', 'Status', 'Partner', 'Offers', 'Deadline', '']}>
                {p.data.map((d) => (
                  <Fragment key={d.id}>
                    <tr className={cn(d.escalated && 'bg-red-50')}>
                      <td>
                        <Link
                          className="font-medium text-brand-700 hover:underline"
                          to={`/orders/${d.order.id}`}
                        >
                          {d.order.number}
                        </Link>
                        <div className="text-xs text-gray-500">
                          {label(d.order.status)} · {label(d.order.paymentMethod)}
                        </div>
                      </td>
                      <td>
                        {d.restaurant.name}
                        <div className="text-xs text-gray-500">{d.restaurant.branch}</div>
                      </td>
                      <td>
                        <Badge value={d.status} />
                        {d.escalated && <Badge value="ESCALATED" className="ml-1" />}
                      </td>
                      <td>
                        {d.partner ? (
                          <Link
                            className="text-brand-700 hover:underline"
                            to={`/partners/${d.partner.id}`}
                          >
                            {d.partner.name}
                          </Link>
                        ) : (
                          '—'
                        )}
                        {d.manualAssignment && (
                          <div className="text-xs text-gray-500">
                            Manual ·{' '}
                            {d.manualAssignment.acknowledgedAt
                              ? 'acknowledged'
                              : `ack by ${dateTime(d.manualAssignment.acknowledgeBy)}`}
                          </div>
                        )}
                      </td>
                      <td>
                        {d.offers} (round {d.searchRound})
                      </td>
                      <td>
                        {dateTime(d.noPartnerDeadline)}
                        {d.deadlineExtended && (
                          <div className="text-xs text-gray-500">extended</div>
                        )}
                      </td>
                      <td className="space-x-2 whitespace-nowrap">
                        <button
                          type="button"
                          className="text-sm text-brand-700 underline"
                          aria-expanded={open === d.id}
                          onClick={() => setOpen(open === d.id ? null : d.id)}
                        >
                          {open === d.id ? 'Hide candidates' : 'Candidates'}
                        </button>
                        <ActionDialog
                          label="Re-dispatch"
                          title="Restart automatic dispatch"
                          description="Releases any partner and starts again from round one."
                          reason="optional"
                          confirmLabel="Re-dispatch"
                          onConfirm={(reason) =>
                            admin.deliveries.redispatch(d.id, reason || undefined)
                          }
                        />
                        {d.status === 'SEARCHING' && !d.deadlineExtended && (
                          <ActionDialog
                            label="Extend deadline"
                            title="Extend the no-partner deadline"
                            description="Allowed once per delivery."
                            confirmLabel="Extend"
                            ready={Number(minutes) >= 5 && Number(minutes) <= 60}
                            onConfirm={(reason) =>
                              admin.deliveries.extendDeadline(d.id, {
                                minutes: Number(minutes),
                                reason,
                              })
                            }
                          >
                            <Field
                              label="Minutes (5–60)"
                              type="number"
                              min={5}
                              max={60}
                              value={minutes}
                              onChange={(e) => setMinutes(e.target.value)}
                            />
                          </ActionDialog>
                        )}
                      </td>
                    </tr>
                    {open === d.id && (
                      <tr>
                        <td colSpan={7} className="bg-gray-50">
                          <Candidates d={d} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </Table>
              <Pager pagination={p.pagination} onPage={setPage} />
            </>
          )
        }
      </Loader>
    </div>
  );
}
