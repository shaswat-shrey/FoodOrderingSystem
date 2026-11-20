import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  isApiClientError,
  type AdminFault,
  type AdminOrder,
  type AdminOrderStatus,
  type AdminRefundInput,
} from '@fos/api-client';
import { Alert } from '@fos/ui';
import {
  ActionDialog,
  Badge,
  Empty,
  Facts,
  Field,
  Filters,
  Json,
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

const ORDER_STATUSES: AdminOrderStatus[] = [
  'PAYMENT_PENDING',
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'FAILED',
];
const ACTIVE: AdminOrderStatus[] = [
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
];
const CLOSED: AdminOrderStatus[] = ['DELIVERED', 'CANCELLED', 'REJECTED', 'FAILED'];
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

export function OrdersPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['orders', search, status, from, to, page],
    queryFn: () =>
      admin.orders.list({
        q: search.trim() || undefined,
        status: (status || undefined) as AdminOrderStatus | undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(to).toISOString() : undefined,
        page,
      }),
  });
  return (
    <div>
      <PageHeader title="Orders" subtitle="Search by order number or the customer’s phone." />
      <Filters>
        <Field
          label="Search"
          type="search"
          placeholder="FOS-… or phone"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={ORDER_STATUSES} any="Any status" />
        </Select>
        <Field label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No orders match.</Empty>
          ) : (
            <>
              <Table
                head={['Order', 'Status', 'Customer', 'Restaurant', 'Total', 'Delivery', 'Placed']}
              >
                {p.data.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link
                        to={`/orders/${o.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {o.number}
                      </Link>
                    </td>
                    <td>
                      <Badge value={o.status} />
                      {o.refundStatus && (
                        <div className="mt-1 text-xs text-gray-500">
                          Refund: {label(o.refundStatus)}
                        </div>
                      )}
                    </td>
                    <td>
                      {o.customer.name}
                      <div className="text-xs text-gray-500">{o.customer.phone}</div>
                    </td>
                    <td>
                      {o.restaurant.name}
                      <div className="text-xs text-gray-500">{o.branch.name}</div>
                    </td>
                    <td>
                      {rupees(o.totalAmount)}
                      <div className="text-xs text-gray-500">{label(o.paymentMethod)}</div>
                    </td>
                    <td>
                      {o.delivery ? (
                        <>
                          <Badge value={o.delivery.status} />
                          {o.delivery.escalated && <Badge value="ESCALATED" className="ml-1" />}
                          <div className="text-xs text-gray-500">
                            {o.delivery.partner?.name ?? 'No partner'}
                          </div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{dateTime(o.placedAt ?? o.createdAt)}</td>
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

function RefundDialog({ order, onDone }: { order: AdminOrder; onDone: (m: string) => void }) {
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState<'SOURCE' | 'WALLET'>(
    order.paymentMethod === 'COD' ? 'WALLET' : 'SOURCE',
  );
  const [reasonCode, setReasonCode] = useState('');
  const [costBearer, setCostBearer] = useState<AdminRefundInput['costBearer']>('PLATFORM');
  const [requestApproval, setRequestApproval] = useState(false);
  const [limit, setLimit] = useState<{ limit?: string; remaining?: string } | null>(null);
  const paise = toPaise(amount);
  return (
    <ActionDialog
      label="Issue refund"
      title={`Refund for ${order.number}`}
      description={`Paid ${rupees(order.amounts.total)}; refunded so far ${rupees(order.refunds.filter((r) => !['FAILED', 'CANCELLED'].includes(r.status)).reduce((s, r) => s + r.amount, 0))}.`}
      confirmLabel={requestApproval ? 'Request approval' : 'Refund'}
      ready={Number.isFinite(paise) && paise > 0 && CODE.test(reasonCode)}
      onConfirm={async (note) => {
        try {
          return await admin.orders.refund(order.id, {
            amount: paise,
            destination,
            reasonCode,
            note,
            costBearer,
            requestApproval,
          });
        } catch (e) {
          if (isApiClientError(e) && e.code === 'REFUND_LIMIT_EXCEEDED') {
            const d = Object.fromEntries(e.details.map((x) => [x.code, x.message]));
            setLimit({ limit: d.LIMIT, remaining: d.REMAINING });
          }
          throw e;
        }
      }}
      onDone={(r) =>
        onDone(
          r.refund.status === 'REQUESTED'
            ? `Refund of ${rupees(r.refund.amount)} sent for approval.`
            : `Refund of ${rupees(r.refund.amount)} created (${label(r.refund.status).toLowerCase()}).`,
        )
      }
    >
      <Field
        label="Amount (₹)"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <Select
        label="Refund to"
        value={destination}
        onChange={(e) => setDestination(e.target.value as 'SOURCE' | 'WALLET')}
      >
        <option value="SOURCE">Original payment method</option>
        <option value="WALLET">Customer wallet</option>
      </Select>
      <Field
        label="Reason code"
        placeholder="e.g. MISSING_ITEM"
        value={reasonCode}
        onChange={(e) => setReasonCode(e.target.value.toUpperCase())}
        hint="UPPER_SNAKE_CASE"
      />
      <Select
        label="Who bears the cost"
        value={costBearer}
        onChange={(e) => setCostBearer(e.target.value as AdminRefundInput['costBearer'])}
      >
        <Options values={['PLATFORM', 'RESTAURANT', 'PARTNER']} />
      </Select>
      {limit && (
        <Alert tone="warning" title="Above your refund limit">
          Your limit is {rupees(Number(limit.limit))} per order
          {limit.remaining !== undefined ? ` (${rupees(Number(limit.remaining))} left)` : ''}. Ask a
          supervisor to approve it instead.
        </Alert>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={requestApproval}
          onChange={(e) => setRequestApproval(e.target.checked)}
        />
        Send for supervisor approval if it exceeds my limit
      </label>
    </ActionDialog>
  );
}

function OrderActions({ o, onDone }: { o: AdminOrder; onDone: (m: string) => void }) {
  const { can } = usePermissions();
  const [reasonCode, setReasonCode] = useState('');
  const [fault, setFault] = useState<AdminFault>('PLATFORM');
  const [cashCollected, setCashCollected] = useState(false);
  const [cause, setCause] = useState<'DELIVERY_FAILED' | 'CUSTOMER_UNREACHABLE'>('DELIVERY_FAILED');
  const [minutes, setMinutes] = useState('5');
  const active = ACTIVE.includes(o.status);
  return (
    <>
      {o.status === 'PLACED' && can('order:ops') && (
        <ActionDialog
          label="Extend acceptance"
          title="Give the restaurant more time to accept"
          confirmLabel="Extend"
          ready={Number(minutes) >= 1 && Number(minutes) <= 15}
          onConfirm={(reason) =>
            admin.orders.extendAcceptance(o.id, { minutes: Number(minutes), reason })
          }
          onDone={(r) => onDone(`Restaurant now has until ${dateTime(r.acceptBy)} to accept.`)}
        >
          <Field
            label="Minutes (1–15)"
            type="number"
            min={1}
            max={15}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </ActionDialog>
      )}
      {o.status === 'PICKED_UP' && can('order:override') && (
        <>
          <ActionDialog
            label="Mark delivered"
            confirmLabel="Mark delivered"
            onConfirm={(reason) =>
              admin.orders.markDelivered(o.id, {
                reason,
                ...(o.paymentMethod === 'COD' ? { cashCollected } : {}),
              })
            }
            onDone={() => onDone('Order marked delivered.')}
          >
            {o.paymentMethod === 'COD' && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cashCollected}
                  onChange={(e) => setCashCollected(e.target.checked)}
                />
                The partner collected the cash
              </label>
            )}
          </ActionDialog>
          <ActionDialog
            label="Mark failed"
            variant="danger"
            title="Mark delivery failed"
            confirmLabel="Mark failed"
            onConfirm={(reason) => admin.orders.markFailed(o.id, { cause, reason })}
            onDone={() => onDone('Delivery marked failed.')}
          >
            <Select
              label="Cause"
              value={cause}
              onChange={(e) =>
                setCause(e.target.value as 'DELIVERY_FAILED' | 'CUSTOMER_UNREACHABLE')
              }
            >
              <Options values={['DELIVERY_FAILED', 'CUSTOMER_UNREACHABLE']} />
            </Select>
          </ActionDialog>
        </>
      )}
      {active && can('order:cancel:any') && (
        <ActionDialog
          label="Cancel order"
          variant="danger"
          title={`Cancel ${o.number}`}
          description="Refunds and penalties follow from who was at fault."
          confirmLabel="Cancel order"
          ready={CODE.test(reasonCode)}
          onConfirm={(reason) => admin.orders.cancel(o.id, { reasonCode, fault, reason })}
          onDone={() => onDone('Order cancelled.')}
        >
          <Field
            label="Reason code"
            placeholder="e.g. RESTAURANT_UNRESPONSIVE"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value.toUpperCase())}
            hint="UPPER_SNAKE_CASE"
          />
          <Select
            label="Fault"
            value={fault}
            onChange={(e) => setFault(e.target.value as AdminFault)}
          >
            <Options values={['CUSTOMER', 'RESTAURANT', 'PARTNER', 'PLATFORM']} />
          </Select>
        </ActionDialog>
      )}
      {CLOSED.includes(o.status) && can('refund:create') && (
        <RefundDialog order={o} onDone={onDone} />
      )}
    </>
  );
}

function AuditTrail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['orders', id, 'audit'], queryFn: () => admin.orders.audit(id) });
  return (
    <Loader query={q}>
      {(a) =>
        a.audit.length === 0 ? (
          <Empty>No admin actions on this order.</Empty>
        ) : (
          <Table head={['When', 'Action', 'By', 'Reason', 'Change']}>
            {a.audit.map((e) => (
              <tr key={e.id}>
                <td>{dateTime(e.at)}</td>
                <td>{e.action}</td>
                <td>{e.actor?.fullName ?? 'system'}</td>
                <td>{e.reason ?? '—'}</td>
                <td>
                  <Json value={e.after} />
                </td>
              </tr>
            ))}
          </Table>
        )
      }
    </Loader>
  );
}

export function OrderPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['orders', id], queryFn: () => admin.orders.get(id) });
  const [message, setMessage] = useState<string | null>(null);
  return (
    <Loader query={q}>
      {(o) => (
        <div className="space-y-4">
          <PageHeader
            back={{ to: '/orders', label: 'Orders' }}
            title={`Order ${o.number}`}
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <Badge value={o.status} /> {o.restaurant.name} · {o.branch.name} ·{' '}
                {label(o.paymentMethod)} · {rupees(o.amounts.total)}
              </span>
            }
            actions={<OrderActions o={o} onDone={setMessage} />}
          />
          {message && <Alert tone="success">{message}</Alert>}
          {o.cancellation && (
            <Alert tone="warning" title="Cancelled">
              {label(o.cancellation.reasonCode)}
              {o.cancellation.fault ? ` · fault: ${label(o.cancellation.fault)}` : ''}
              {o.cancellation.note ? ` · ${o.cancellation.note}` : ''}
            </Alert>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Customer">
              <Facts
                items={[
                  [
                    'Customer',
                    <Link
                      key="c"
                      to={`/users/${o.customer.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {o.customer.name}
                    </Link>,
                  ],
                  ['Phone', o.customer.phone],
                  ['Contact', [o.contact.name, o.contact.phone].filter(Boolean).join(' · ')],
                  [
                    'Address',
                    o.address
                      ? `${o.address.line1}, ${o.address.area}, ${o.address.city} ${o.address.pincode}`
                      : '—',
                  ],
                ]}
              />
            </Section>
            <Section title="Amounts">
              <Facts
                items={[
                  ['Items', rupees(o.amounts.itemsSubtotal)],
                  ['Discounts', rupees(-o.amounts.discounts)],
                  ['Fees', rupees(o.amounts.fees)],
                  ['Taxes', rupees(o.amounts.taxes)],
                  ['Tip', rupees(o.amounts.tip)],
                  ['Wallet used', rupees(o.amounts.wallet)],
                  ['Total', rupees(o.amounts.total)],
                  ['Payable', rupees(o.amounts.payable)],
                ]}
              />
            </Section>
          </div>
          <Section title="Items">
            <Table head={['Item', 'Qty', 'Total']}>
              {o.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.name}
                    {i.variant ? ` (${i.variant})` : ''}
                    {i.options.length > 0 && (
                      <div className="text-xs text-gray-500">{i.options.join(', ')}</div>
                    )}
                  </td>
                  <td>{i.quantity}</td>
                  <td>{rupees(i.lineTotal)}</td>
                </tr>
              ))}
            </Table>
          </Section>
          <Section title="Timeline">
            <ol className="space-y-1 text-sm">
              {o.statusHistory.map((h, i) => (
                <li key={i} className="flex flex-wrap gap-2">
                  <span className="w-32 shrink-0 text-gray-500">{dateTime(h.at)}</span>
                  <Badge value={h.to} />
                  <span className="text-gray-600">
                    by {label(h.actorType).toLowerCase()}
                    {h.reason ? ` — ${h.reason}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
          <Section title="Payments">
            {o.payments.length === 0 ? (
              <Empty>No payments.</Empty>
            ) : (
              <Table head={['Payment', 'Status', 'Amount', 'Captured', 'Refunded', 'Attempts']}>
                {o.payments.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/payments/${p.id}`} className="text-brand-700 hover:underline">
                        {label(p.method)} · {label(p.provider)}
                      </Link>
                      <div className="text-xs text-gray-500">
                        {p.instrument ?? p.providerOrderId ?? ''}
                      </div>
                    </td>
                    <td>
                      <Badge value={p.status} />
                      {p.failureCode && <div className="text-xs text-red-700">{p.failureCode}</div>}
                    </td>
                    <td>{rupees(p.amount)}</td>
                    <td>{rupees(p.capturedAmount)}</td>
                    <td>{rupees(p.refundedAmount)}</td>
                    <td>{p.attempts.length}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
          <Section title="Refunds">
            {o.refunds.length === 0 ? (
              <Empty>No refunds.</Empty>
            ) : (
              <Table head={['Amount', 'Status', 'To', 'Reason', 'Cost', 'Created']}>
                {o.refunds.map((r) => (
                  <tr key={r.id}>
                    <td>{rupees(r.amount)}</td>
                    <td>
                      <Badge value={r.status} />
                    </td>
                    <td>{label(r.destination)}</td>
                    <td>
                      {label(r.reasonCode)}
                      {r.note && <div className="text-xs text-gray-500">{r.note}</div>}
                    </td>
                    <td>{label(r.costBearer)}</td>
                    <td>{dateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
          <Section title="Delivery">
            {o.delivery ? (
              <div className="space-y-3">
                <Facts
                  items={[
                    ['Status', <Badge key="s" value={o.delivery.status} />],
                    [
                      'Partner',
                      o.delivery.partner ? (
                        <Link
                          key="p"
                          className="text-brand-700 hover:underline"
                          to={`/partners/${o.delivery.partner.id}`}
                        >
                          {o.delivery.partner.name} · {o.delivery.partner.phone}
                        </Link>
                      ) : (
                        'Not assigned'
                      ),
                    ],
                    ['Escalated', o.delivery.escalated ? 'Yes' : 'No'],
                    ['Search round', o.delivery.searchRound],
                    ['No-partner deadline', dateTime(o.delivery.noPartnerDeadline)],
                    ['Proof', label(o.delivery.proofType)],
                  ]}
                />
                {o.delivery.assignments.length > 0 && (
                  <Table head={['Partner', 'Offer', 'Round', 'Distance', 'Offered', 'Responded']}>
                    {o.delivery.assignments.map((a) => (
                      <tr key={a.id}>
                        <td>{a.partner.name}</td>
                        <td>
                          <Badge value={a.status} />{' '}
                          {a.manual && <span className="text-xs">manual</span>}
                          {a.rejectReason && (
                            <div className="text-xs text-gray-500">{label(a.rejectReason)}</div>
                          )}
                        </td>
                        <td>{a.round}</td>
                        <td>
                          {a.distanceToPickupM == null
                            ? '—'
                            : `${(a.distanceToPickupM / 1000).toFixed(1)} km`}
                        </td>
                        <td>{dateTime(a.offeredAt)}</td>
                        <td>{dateTime(a.respondedAt)}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </div>
            ) : (
              <Empty>No delivery yet.</Empty>
            )}
          </Section>
          {can('audit:read') && (
            <Section title="Audit trail">
              <AuditTrail id={id} />
            </Section>
          )}
        </div>
      )}
    </Loader>
  );
}
