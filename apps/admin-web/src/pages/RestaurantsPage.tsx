import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { AdminAccountStatus, AdminChangeRequest, AdminChangeType } from '@fos/api-client';
import { Alert } from '@fos/ui';
import {
  ActionDialog,
  Badge,
  Empty,
  Facts,
  Field,
  Filters,
  Loader,
  Options,
  PageHeader,
  Pager,
  Section,
  Select,
  Table,
} from '../components/ui';
import { admin } from '../lib/admin';
import { bps, dateTime, day, label } from '../lib/format';
import { usePermissions } from '../lib/permissions';

const ACCOUNT: AdminAccountStatus[] = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'];

export function RestaurantsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['restaurants', search, status, page],
    queryFn: () =>
      admin.restaurants.list({
        q: search.trim() || undefined,
        status: (status || undefined) as AdminAccountStatus | undefined,
        page,
      }),
  });
  return (
    <div>
      <PageHeader title="Restaurants" subtitle="Approved restaurants and their outlets." />
      <Filters>
        <Field
          label="Search"
          type="search"
          placeholder="Brand, legal name or FSSAI"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={ACCOUNT} any="Any status" />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No restaurants match.</Empty>
          ) : (
            <>
              <Table head={['Restaurant', 'Status', 'Outlets', 'COD', 'Rating', 'Approved']}>
                {p.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link
                        to={`/restaurants/${r.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {r.brandName}
                      </Link>
                    </td>
                    <td>
                      <Badge value={r.status} />
                    </td>
                    <td>{r.branches.length}</td>
                    <td>{r.codEnabled ? 'On' : 'Off'}</td>
                    <td>{r.rating ? `${r.rating.average.toFixed(1)} (${r.rating.count})` : '—'}</td>
                    <td>{day(r.approvedAt)}</td>
                  </tr>
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

export function RestaurantPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['restaurants', id], queryFn: () => admin.restaurants.get(id) });
  const [cancelActive, setCancelActive] = useState(false);
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const rateBps = Math.round(Number(rate) * 100);
  const rateOk = rate.trim() !== '' && Number.isFinite(rateBps) && rateBps >= 0 && rateBps <= 5000;

  return (
    <Loader query={q}>
      {(r) => (
        <div className="space-y-4">
          <PageHeader
            back={{ to: '/restaurants', label: 'Restaurants' }}
            title={r.brandName}
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <Badge value={r.status} /> {r.legalName} · approved {day(r.approvedAt)}
              </span>
            }
            actions={
              r.status === 'SUSPENDED' ? (
                <ActionDialog
                  label="Unsuspend"
                  confirmLabel="Unsuspend"
                  onConfirm={(reason) => admin.restaurants.unsuspend(id, reason)}
                />
              ) : (
                <ActionDialog
                  label="Suspend"
                  variant="danger"
                  title={`Suspend ${r.brandName}`}
                  description="New orders stop at once and staff lose access."
                  confirmLabel="Suspend"
                  onConfirm={(reason) => admin.restaurants.suspend(id, reason, cancelActive)}
                  onDone={(res) =>
                    res.cancelledOrders !== undefined &&
                    setNote(
                      `${res.cancelledOrders} active orders cancelled; ${res.notCancelledOrders ?? 0} could not be.`,
                    )
                  }
                >
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={cancelActive}
                      onChange={(e) => setCancelActive(e.target.checked)}
                    />
                    Also cancel active orders not yet picked up (restaurant fault)
                  </label>
                </ActionDialog>
              )
            }
          />
          {note && <Alert tone="info">{note}</Alert>}
          {r.pendingChanges.length > 0 && (
            <Alert tone="warning" title="Pending change requests">
              {r.pendingChanges.map(label).join(', ')} —{' '}
              <Link className="underline" to="/change-requests">
                review
              </Link>
            </Alert>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Profile">
              <Facts
                items={[
                  ['Entity', label(r.entityType)],
                  ['PAN', r.panMasked],
                  ['GSTIN', r.gstin],
                  ['FSSAI', `${r.fssaiNumber ?? '—'} (expires ${day(r.fssaiExpiresOn)})`],
                  ['Contact', [r.contactEmail, r.contactPhone].filter(Boolean).join(' · ')],
                  ['Cuisines', r.cuisines.map((c) => c.name).join(', ')],
                  ['Rating', r.rating ? `${r.rating.average.toFixed(1)} (${r.rating.count})` : '—'],
                  ['Orders', `${r.orders.delivered} delivered of ${r.orders.total}`],
                  ['Bank', r.bank ? `${r.bank.holderName} · ${r.bank.accountMasked}` : '—'],
                ]}
              />
            </Section>
            <Section
              title="Commission and payments"
              aside={
                <div className="flex gap-2">
                  {can('commission:write') && (
                    <ActionDialog
                      label="Override commission"
                      title="Commission override"
                      description="A new rate from a date; earlier rates are kept."
                      confirmLabel="Save rate"
                      ready={rateOk}
                      onConfirm={(reason) =>
                        admin.restaurants.setCommission(id, {
                          rateBps,
                          reason,
                          ...(from ? { effectiveFrom: new Date(from).toISOString() } : {}),
                        })
                      }
                    >
                      <Field
                        label="Rate (%)"
                        inputMode="decimal"
                        value={rate}
                        onChange={(e) => setRate(e.target.value)}
                        hint="0–50%"
                      />
                      <Field
                        label="Effective from (optional, default now)"
                        type="datetime-local"
                        value={from}
                        onChange={(e) => setFrom(e.target.value)}
                      />
                    </ActionDialog>
                  )}
                  <ActionDialog
                    label={r.codEnabled ? 'Disable COD' : 'Enable COD'}
                    confirmLabel={r.codEnabled ? 'Disable COD' : 'Enable COD'}
                    onConfirm={(reason) => admin.restaurants.setCod(id, !r.codEnabled, reason)}
                  />
                </div>
              }
            >
              <Facts
                items={[
                  [
                    'Commission',
                    r.commission
                      ? `${bps(r.commission.rateBps)} (${label(r.commission.source)})`
                      : '—',
                  ],
                  ...(r.commission?.scheduled ?? []).map(
                    (s) =>
                      [`From ${dateTime(s.effectiveFrom)}`, bps(s.rateBps)] as [string, string],
                  ),
                  ['Cash on delivery', r.codEnabled ? 'Enabled' : 'Disabled'],
                ]}
              />
            </Section>
          </div>
          <Section title="Outlets">
            {r.branches.length === 0 ? (
              <Empty>No outlets.</Empty>
            ) : (
              <Table head={['Outlet', 'Zone', 'Status', 'Open', '']}>
                {r.branches.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.name}
                      <div className="text-xs text-gray-500">
                        {b.area}, {b.city}
                      </div>
                    </td>
                    <td>{b.zone?.name ?? '—'}</td>
                    <td>
                      <Badge value={b.status} />
                    </td>
                    <td>
                      {b.isOpenManual
                        ? b.pausedUntil
                          ? `Paused to ${dateTime(b.pausedUntil)}`
                          : 'Open'
                        : 'Closed'}
                    </td>
                    <td className="space-x-2 whitespace-nowrap">
                      {b.status === 'PENDING_APPROVAL' && (
                        <ActionDialog
                          label="Approve"
                          title={`Approve ${b.name}`}
                          confirmLabel="Approve"
                          onConfirm={(reason) => admin.branches.setStatus(b.id, 'approve', reason)}
                        />
                      )}
                      {b.status === 'ACTIVE' && (
                        <ActionDialog
                          label="Suspend"
                          variant="danger"
                          title={`Suspend ${b.name}`}
                          confirmLabel="Suspend"
                          onConfirm={(reason) => admin.branches.setStatus(b.id, 'suspend', reason)}
                        />
                      )}
                      {b.status === 'SUSPENDED' && (
                        <ActionDialog
                          label="Unsuspend"
                          title={`Unsuspend ${b.name}`}
                          confirmLabel="Unsuspend"
                          onConfirm={(reason) =>
                            admin.branches.setStatus(b.id, 'unsuspend', reason)
                          }
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
          <Section title="Team">
            <Table head={['Name', 'Phone', 'Role', 'Status']}>
              {r.members.map((m) => (
                <tr key={m.user.id}>
                  <td>
                    <Link to={`/users/${m.user.id}`} className="text-brand-700 hover:underline">
                      {m.user.fullName}
                    </Link>
                  </td>
                  <td>{m.user.phone}</td>
                  <td>{label(m.role)}</td>
                  <td>
                    <Badge value={m.status} />
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
        </div>
      )}
    </Loader>
  );
}

const CHANGE_TYPES: AdminChangeType[] = ['LEGAL_NAME', 'PAN', 'GSTIN', 'FSSAI', 'BANK_ACCOUNT'];

export function ChangeRequestsPage() {
  const [type, setType] = useState('');
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['change-requests', type, status, page],
    queryFn: () =>
      admin.changeRequests.list({
        type: (type || undefined) as AdminChangeType | undefined,
        status: status as AdminChangeRequest['status'],
        page,
      }),
  });
  return (
    <div>
      <PageHeader title="Change requests" subtitle="Legal, tax and bank changes need approval." />
      <Filters>
        <Select label="Type" value={type} onChange={(e) => setType(e.target.value)}>
          <Options values={CHANGE_TYPES} any="Any type" />
        </Select>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']} />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No change requests.</Empty>
          ) : (
            <>
              <Table head={['Restaurant', 'Change', 'Requested values', 'Note', 'Requested', '']}>
                {p.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link
                        className="text-brand-700 hover:underline"
                        to={`/restaurants/${c.restaurant.id}`}
                      >
                        {c.restaurant.brandName}
                      </Link>
                    </td>
                    <td>
                      {label(c.type)} <Badge value={c.status} />
                    </td>
                    <td>
                      {Object.entries(c.requested).map(([k, v]) => (
                        <div key={k}>
                          <span className="text-gray-500">{k}:</span> {v}
                        </div>
                      ))}
                    </td>
                    <td>{c.reason ?? '—'}</td>
                    <td>{dateTime(c.createdAt)}</td>
                    <td className="space-x-2 whitespace-nowrap">
                      {c.status === 'PENDING' && (
                        <>
                          <ActionDialog
                            label="Approve"
                            variant="primary"
                            title={`Approve ${label(c.type).toLowerCase()} change`}
                            confirmLabel="Approve"
                            onConfirm={(reason) =>
                              admin.changeRequests.decide(c.id, 'approve', reason)
                            }
                          />
                          <ActionDialog
                            label="Reject"
                            variant="danger"
                            title={`Reject ${label(c.type).toLowerCase()} change`}
                            confirmLabel="Reject"
                            onConfirm={(reason) =>
                              admin.changeRequests.decide(c.id, 'reject', reason)
                            }
                          />
                        </>
                      )}
                    </td>
                  </tr>
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
