import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { AdminAccountStatus } from '@fos/api-client';
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
import { dateTime, label, rupees, toPaise } from '../lib/format';
import { usePermissions } from '../lib/permissions';

export function PartnersPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [online, setOnline] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['partners', search, status, online, page],
    queryFn: () =>
      admin.partners.list({
        q: search.trim() || undefined,
        status: (status || undefined) as AdminAccountStatus | undefined,
        online: online === '' ? undefined : online === 'true',
        page,
      }),
  });
  return (
    <div>
      <PageHeader
        title="Delivery partners"
        subtitle="Approved partners with their live availability."
      />
      <Filters>
        <Field
          label="Search"
          type="search"
          placeholder="Name or phone"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={['ACTIVE', 'SUSPENDED', 'DEACTIVATED']} any="Any status" />
        </Select>
        <Select label="Online" value={online} onChange={(e) => setOnline(e.target.value)}>
          <option value="">Online or offline</option>
          <option value="true">Online now</option>
          <option value="false">Offline</option>
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No partners match.</Empty>
          ) : (
            <>
              <Table
                head={['Partner', 'Phone', 'Zone', 'Status', 'Availability', 'Rating', 'Today']}
              >
                {p.data.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link
                        to={`/partners/${x.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {x.legalName ?? 'Unnamed'}
                      </Link>
                    </td>
                    <td>{x.phone ?? '—'}</td>
                    <td>{x.zone?.name ?? '—'}</td>
                    <td>
                      <Badge value={x.status} />
                    </td>
                    <td>
                      <Badge value={x.availability} />
                    </td>
                    <td>{x.rating ? `${x.rating.average.toFixed(1)} (${x.rating.count})` : '—'}</td>
                    <td>{x.deliveriesToday}</td>
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

function LocationTrail({ partnerId, deliveryId }: { partnerId: string; deliveryId: string }) {
  const q = useQuery({
    queryKey: ['partners', partnerId, 'trail', deliveryId],
    queryFn: () => admin.partners.locationTrail(partnerId, deliveryId),
  });
  return (
    <Loader query={q}>
      {(t) =>
        t.points.length === 0 ? (
          <Empty>No location points recorded for this delivery.</Empty>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <Table head={['Time', 'Latitude', 'Longitude', 'Accuracy', 'Speed']}>
              {t.points.map((p, i) => (
                <tr key={i}>
                  <td>{dateTime(p.recordedAt)}</td>
                  <td>{p.lat.toFixed(5)}</td>
                  <td>{p.lng.toFixed(5)}</td>
                  <td>{Math.round(p.accuracyM)} m</td>
                  <td>{p.speedKmh == null ? '—' : `${Math.round(p.speedKmh)} km/h`}</td>
                </tr>
              ))}
            </Table>
          </div>
        )
      }
    </Loader>
  );
}

export function PartnerPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['partners', id], queryFn: () => admin.partners.get(id) });
  const [deposit, setDeposit] = useState({ amount: '', method: 'HUB', reference: '' });
  const [adjust, setAdjust] = useState({ amount: '', note: '' });
  const [trailFor, setTrailFor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const depositPaise = toPaise(deposit.amount);
  const adjustPaise = toPaise(adjust.amount);

  return (
    <Loader query={q}>
      {(p) => {
        const name = p.legalName ?? p.user.fullName;
        return (
          <div className="space-y-4">
            <PageHeader
              back={{ to: '/partners', label: 'Partners' }}
              title={name}
              subtitle={
                <span className="flex flex-wrap items-center gap-2">
                  <Badge value={p.accountStatus} /> <Badge value={p.presence.state} />
                  {p.homeZone?.name} · {p.user.phone}
                </span>
              }
              actions={
                <>
                  {p.presence.state !== 'OFFLINE' && (
                    <ActionDialog
                      label="Force offline"
                      title="Take partner offline"
                      description="On a delivery, they go offline once it ends."
                      confirmLabel="Force offline"
                      onConfirm={(reason) => admin.partners.forceOffline(id, reason)}
                      onDone={(r) =>
                        setMessage(
                          r.offline
                            ? 'Partner is offline.'
                            : 'Partner goes offline after the current delivery.',
                        )
                      }
                    />
                  )}
                  {p.accountStatus === 'SUSPENDED' ? (
                    <ActionDialog
                      label="Unsuspend"
                      confirmLabel="Unsuspend"
                      onConfirm={(reason) => admin.partners.unsuspend(id, reason)}
                    />
                  ) : (
                    <ActionDialog
                      label="Suspend"
                      variant="danger"
                      title={`Suspend ${name}`}
                      confirmLabel="Suspend"
                      onConfirm={(reason) => admin.partners.suspend(id, reason)}
                    />
                  )}
                </>
              }
            />
            {message && <Alert tone="success">{message}</Alert>}
            <div className="grid gap-4 lg:grid-cols-2">
              <Section
                title="Cash and earnings"
                aside={
                  <div className="flex gap-2">
                    {can('partner:cash') && (
                      <ActionDialog
                        label="Record cash deposit"
                        title="Record cash deposit"
                        description={`Cash in hand: ${rupees(p.cashInHand)}.`}
                        confirmLabel="Record deposit"
                        ready={Number.isFinite(depositPaise) && depositPaise > 0}
                        onConfirm={(reason) =>
                          admin.partners.cashDeposit(id, {
                            amount: depositPaise,
                            method: deposit.method as 'HUB' | 'UPI' | 'BANK',
                            reason,
                            ...(deposit.reference.trim()
                              ? { reference: deposit.reference.trim() }
                              : {}),
                          })
                        }
                        onDone={(r) => {
                          setDeposit({ amount: '', method: 'HUB', reference: '' });
                          setMessage(`Deposit recorded; cash in hand ${rupees(r.cashInHand)}.`);
                        }}
                      >
                        <Field
                          label="Amount (₹)"
                          inputMode="decimal"
                          value={deposit.amount}
                          onChange={(e) => setDeposit({ ...deposit, amount: e.target.value })}
                        />
                        <Select
                          label="Method"
                          value={deposit.method}
                          onChange={(e) => setDeposit({ ...deposit, method: e.target.value })}
                        >
                          <Options values={['HUB', 'UPI', 'BANK']} />
                        </Select>
                        <Field
                          label="Reference (optional)"
                          value={deposit.reference}
                          onChange={(e) => setDeposit({ ...deposit, reference: e.target.value })}
                        />
                      </ActionDialog>
                    )}
                    {can('earnings:adjust') && (
                      <ActionDialog
                        label="Adjust earnings"
                        title="Adjust earnings"
                        description="Positive credits the partner; negative deducts. Shown in their statement."
                        confirmLabel="Post adjustment"
                        ready={Number.isFinite(adjustPaise) && adjustPaise !== 0}
                        onConfirm={(reason) =>
                          admin.partners.adjustEarnings(id, {
                            amount: adjustPaise,
                            reason,
                            ...(adjust.note.trim() ? { note: adjust.note.trim() } : {}),
                          })
                        }
                        onDone={(r) => {
                          setAdjust({ amount: '', note: '' });
                          setMessage(`Earnings adjusted; balance ${rupees(r.earningsBalance)}.`);
                        }}
                      >
                        <Field
                          label="Amount (₹)"
                          inputMode="decimal"
                          value={adjust.amount}
                          onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })}
                        />
                        <Field
                          label="Statement note (optional)"
                          value={adjust.note}
                          onChange={(e) => setAdjust({ ...adjust, note: e.target.value })}
                        />
                      </ActionDialog>
                    )}
                  </div>
                }
              >
                <Facts
                  items={[
                    ['Cash in hand', rupees(p.cashInHand)],
                    ['Earnings balance', rupees(p.earningsBalance)],
                    [
                      'Active delivery',
                      p.activeDelivery ? (
                        <Link
                          key="a"
                          className="text-brand-700 hover:underline"
                          to={`/orders/${p.activeDelivery.orderId}`}
                        >
                          {label(p.activeDelivery.status)}
                        </Link>
                      ) : (
                        '—'
                      ),
                    ],
                    ['Last seen', dateTime(p.presence.at)],
                    [
                      'Location',
                      p.presence.location
                        ? `${p.presence.location.lat.toFixed(5)}, ${p.presence.location.lng.toFixed(5)}`
                        : '—',
                    ],
                  ]}
                />
              </Section>
              <Section title="Profile">
                <Facts
                  items={[
                    ['Account', p.user.fullName],
                    ['Home zone', p.homeZone?.name],
                    [
                      'Vehicles',
                      p.vehicles
                        .map((v) => `${label(v.type)} ${v.registrationNumber ?? ''}`)
                        .join(', '),
                    ],
                    ['PAN', p.panMasked],
                    ['Bank', p.bank ? `${p.bank.accountMasked} · ${p.bank.ifsc}` : '—'],
                    ...Object.entries(p.performance ?? {})
                      .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
                      .slice(0, 6)
                      .map(
                        ([k, v]) =>
                          [label(k.replace(/([A-Z])/g, '_$1')), String(v)] as [string, string],
                      ),
                  ]}
                />
              </Section>
            </div>
            <Section title="Recent deliveries">
              {p.recentDeliveries.length === 0 ? (
                <Empty>No deliveries yet.</Empty>
              ) : (
                <Table head={['Order', 'Status', 'Created', 'Delivered', '']}>
                  {p.recentDeliveries.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link
                          className="text-brand-700 hover:underline"
                          to={`/orders/${d.order.id}`}
                        >
                          {d.order.number}
                        </Link>
                      </td>
                      <td>
                        <Badge value={d.status} />
                      </td>
                      <td>{dateTime(d.createdAt)}</td>
                      <td>{dateTime(d.deliveredAt)}</td>
                      <td>
                        {can('partner:location') && (
                          <button
                            type="button"
                            className="text-sm text-brand-700 underline"
                            onClick={() => setTrailFor(trailFor === d.id ? null : d.id)}
                          >
                            {trailFor === d.id ? 'Hide trail' : 'Location trail'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
            {trailFor && (
              <Section title="Location trail">
                <LocationTrail partnerId={id} deliveryId={trailFor} />
              </Section>
            )}
          </div>
        );
      }}
    </Loader>
  );
}
