import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import type { AdminBatchStatus, AdminPayeeType, AdminPayoutLine } from '@fos/api-client';
import { Alert, Button } from '@fos/ui';
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
  ServerError,
  Table,
  Tabs,
} from '../components/ui';
import { admin } from '../lib/admin';
import { dateTime, day, label, rupees } from '../lib/format';
import { usePermissions } from '../lib/permissions';

const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'COLLECTED',
];
const PROVIDERS = ['RAZORPAY', 'STRIPE', 'MOCK', 'NONE'];

function PaymentList() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['payments', search, status, provider, page],
    queryFn: () =>
      admin.payments.list({
        q: search.trim() || undefined,
        status: status || undefined,
        provider: provider || undefined,
        page,
      }),
  });
  return (
    <>
      <Filters>
        <Field
          label="Search"
          type="search"
          placeholder="Order number or provider id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={PAYMENT_STATUSES} any="Any status" />
        </Select>
        <Select label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <Options values={PROVIDERS} any="Any provider" />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No payments match.</Empty>
          ) : (
            <>
              <Table
                head={['Payment', 'Order', 'Status', 'Amount', 'Captured', 'Refunded', 'Created']}
              >
                {p.data.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link className="text-brand-700 hover:underline" to={`/payments/${x.id}`}>
                        {label(x.method)} · {label(x.provider)}
                      </Link>
                      <div className="text-xs text-gray-500">{x.providerOrderId ?? ''}</div>
                    </td>
                    <td>
                      <Link className="text-brand-700 hover:underline" to={`/orders/${x.order.id}`}>
                        {x.order.number}
                      </Link>
                    </td>
                    <td>
                      <Badge value={x.status} />
                      {x.failure && <div className="text-xs text-red-700">{x.failure.code}</div>}
                    </td>
                    <td>{rupees(x.amount)}</td>
                    <td>{rupees(x.capturedAmount)}</td>
                    <td>{rupees(x.refundedAmount)}</td>
                    <td>{dateTime(x.createdAt)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={p.pagination} onPage={setPage} />
            </>
          )
        }
      </Loader>
    </>
  );
}

function WebhookLog() {
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['webhooks', provider, status, page],
    queryFn: () =>
      admin.payments.webhooks({
        provider: provider || undefined,
        status: status || undefined,
        page,
      }),
  });
  return (
    <>
      <Filters>
        <Select label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <Options values={PROVIDERS} any="Any provider" />
        </Select>
        <Select label="Processing" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']} any="Any" />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No webhook events.</Empty>
          ) : (
            <>
              <Table head={['Received', 'Provider', 'Event', 'Signature', 'Processing', 'Error']}>
                {p.data.map((w) => (
                  <tr key={w.id}>
                    <td>{dateTime(w.receivedAt)}</td>
                    <td>{label(w.provider)}</td>
                    <td>
                      {w.eventType}
                      <div className="text-xs text-gray-500">{w.eventId}</div>
                    </td>
                    <td>{w.signatureValid ? 'Valid' : 'Invalid'}</td>
                    <td>
                      <Badge value={w.processingStatus} />
                    </td>
                    <td className="text-xs text-red-700">{w.error ?? ''}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={p.pagination} onPage={setPage} />
            </>
          )
        }
      </Loader>
    </>
  );
}

export function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'webhooks' ? 'webhooks' : 'payments';
  return (
    <div>
      <PageHeader title="Payments" />
      <Tabs
        tabs={[
          { key: 'payments', label: 'Payments' },
          { key: 'webhooks', label: 'Webhook log' },
        ]}
        value={tab}
        onChange={(t) => setParams({ tab: t })}
      />
      {tab === 'payments' ? <PaymentList /> : <WebhookLog />}
    </div>
  );
}

export function PaymentPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['payments', id], queryFn: () => admin.payments.get(id) });
  const [synced, setSynced] = useState<string | null>(null);
  return (
    <Loader query={q}>
      {(p) => (
        <div className="space-y-4">
          <PageHeader
            back={{ to: '/payments', label: 'Payments' }}
            title={`${label(p.method)} payment · ${rupees(p.amount)}`}
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <Badge value={p.status} /> {label(p.provider)} · order{' '}
                <Link className="text-brand-700 hover:underline" to={`/orders/${p.order.id}`}>
                  {p.order.number}
                </Link>
              </span>
            }
            actions={
              can('payment:ops') && (
                <ActionDialog
                  label="Sync with provider"
                  title="Sync with provider"
                  description="Fetches the provider’s view of this payment and applies it."
                  confirmLabel="Sync"
                  onConfirm={(reason) => admin.payments.sync(id, reason)}
                  onDone={(r) =>
                    setSynced(`Synced; status is now ${label(r.status).toLowerCase()}.`)
                  }
                />
              )
            }
          />
          {synced && <Alert tone="success">{synced}</Alert>}
          <Section title="Summary">
            <Facts
              items={[
                ['Provider order', p.providerOrderId],
                ['Instrument', p.instrument],
                ['Captured', `${rupees(p.capturedAmount)} at ${dateTime(p.capturedAt)}`],
                ['Refunded', rupees(p.refundedAmount)],
                ['Failure', p.failure ? `${p.failure.code} ${p.failure.reason ?? ''}` : '—'],
                ['Created', dateTime(p.createdAt)],
              ]}
            />
          </Section>
          <Section title="Attempts">
            {p.attempts.length === 0 ? (
              <Empty>No attempts.</Empty>
            ) : (
              <Table head={['When', 'Provider payment', 'Status', 'Amount', 'Method', 'Error']}>
                {p.attempts.map((a) => (
                  <tr key={a.id}>
                    <td>{dateTime(a.createdAt)}</td>
                    <td>{a.providerPaymentId ?? '—'}</td>
                    <td>
                      <Badge value={a.status} />
                    </td>
                    <td>{rupees(a.amount)}</td>
                    <td>{a.methodDetail ?? '—'}</td>
                    <td>{a.errorCode ?? ''}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
          <Section title="Refunds">
            {p.refunds.length === 0 ? (
              <Empty>No refunds.</Empty>
            ) : (
              <Table head={['Amount', 'Status', 'To', 'Provider refund', 'Created']}>
                {p.refunds.map((r) => (
                  <tr key={r.id}>
                    <td>{rupees(r.amount)}</td>
                    <td>
                      <Badge value={r.status} />
                    </td>
                    <td>{label(r.destination)}</td>
                    <td>{r.providerRefundId ?? '—'}</td>
                    <td>{dateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
          <Section title="Webhook events">
            {p.webhookEvents.length === 0 ? (
              <Empty>No webhook events matched this payment.</Empty>
            ) : (
              <Table head={['Received', 'Event', 'Signature', 'Processing', 'Error']}>
                {p.webhookEvents.map((w) => (
                  <tr key={w.id}>
                    <td>{dateTime(w.receivedAt)}</td>
                    <td>{w.eventType}</td>
                    <td>{w.signatureValid ? 'Valid' : 'Invalid'}</td>
                    <td>
                      <Badge value={w.processingStatus} />
                    </td>
                    <td>{w.error ?? ''}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        </div>
      )}
    </Loader>
  );
}

export function RefundsPage() {
  const { can } = usePermissions();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['refunds', status, page],
    queryFn: () => admin.refunds.list({ status: status || undefined, page }),
  });
  return (
    <div>
      <PageHeader
        title="Refunds"
        subtitle="Approve requests above the support limit and retry failures."
      />
      <Filters>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options
            values={['REQUESTED', 'APPROVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED']}
            any="Any status"
          />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No refunds.</Empty>
          ) : (
            <>
              <Table head={['Order', 'Amount', 'Status', 'To', 'Reason', 'By', 'Created', '']}>
                {p.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="text-brand-700 hover:underline" to={`/orders/${r.orderId}`}>
                        {r.order?.number ?? r.orderId.slice(0, 8)}
                      </Link>
                    </td>
                    <td>{rupees(r.amount)}</td>
                    <td>
                      <Badge value={r.status} />
                      {r.attempts > 1 && (
                        <div className="text-xs text-gray-500">{r.attempts} attempts</div>
                      )}
                    </td>
                    <td>{label(r.destination)}</td>
                    <td>
                      {label(r.reasonCode)}
                      {r.note && <div className="text-xs text-gray-500">{r.note}</div>}
                    </td>
                    <td>{r.initiator?.fullName ?? label(r.initiatorType)}</td>
                    <td>{dateTime(r.createdAt)}</td>
                    <td className="whitespace-nowrap">
                      {r.status === 'REQUESTED' && can('refund:approve') && (
                        <ActionDialog
                          label="Approve"
                          variant="primary"
                          title={`Approve refund of ${rupees(r.amount)}`}
                          confirmLabel="Approve"
                          onConfirm={(reason) => admin.refunds.approve(r.id, reason)}
                        />
                      )}
                      {r.status === 'FAILED' && can('refund:create') && (
                        <ActionDialog
                          label="Retry"
                          title={`Retry refund of ${rupees(r.amount)}`}
                          confirmLabel="Retry"
                          onConfirm={(reason) => admin.refunds.retry(r.id, reason)}
                        />
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

export function PayoutsPage() {
  const { can } = usePermissions();
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [newType, setNewType] = useState<AdminPayeeType>('RESTAURANT');
  const [periodStart, setPeriodStart] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['payouts', type, status, page],
    queryFn: () =>
      admin.payouts.list({
        type: (type || undefined) as AdminPayeeType | undefined,
        status: (status || undefined) as AdminBatchStatus | undefined,
        page,
      }),
  });
  return (
    <div>
      <PageHeader
        title="Payout batches"
        subtitle="Weekly settlements to restaurants and partners."
        actions={
          can('payout:create') && (
            <ActionDialog
              label="Create batch"
              variant="primary"
              title="Create a payout batch"
              description="Collects every pending payable for one week (Monday 00:00 IST). Leave the week empty for last week."
              confirmLabel="Create batch"
              onConfirm={(reason) =>
                admin.payouts.create({
                  type: newType,
                  reason,
                  ...(periodStart
                    ? { periodStart: new Date(`${periodStart}T00:00:00+05:30`).toISOString() }
                    : {}),
                })
              }
              onDone={(b) => setCreated(b.id)}
            >
              <Select
                label="Payee"
                value={newType}
                onChange={(e) => setNewType(e.target.value as AdminPayeeType)}
              >
                <Options values={['RESTAURANT', 'PARTNER']} />
              </Select>
              <Field
                label="Week starting (Monday, optional)"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </ActionDialog>
          )
        }
      />
      {created && (
        <Alert tone="success" className="mb-3">
          Batch created.{' '}
          <Link className="underline" to={`/payouts/${created}`}>
            Open it
          </Link>
        </Alert>
      )}
      <Filters>
        <Select label="Payee" value={type} onChange={(e) => setType(e.target.value)}>
          <Options values={['RESTAURANT', 'PARTNER']} any="All payees" />
        </Select>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options
            values={['DRAFT', 'APPROVED', 'PROCESSING', 'PAID', 'PARTIALLY_FAILED']}
            any="Any status"
          />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No payout batches.</Empty>
          ) : (
            <>
              <Table head={['Week', 'Payee', 'Status', 'Lines', 'Amount', 'Paid', 'Failed']}>
                {p.data.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link
                        className="font-medium text-brand-700 hover:underline"
                        to={`/payouts/${b.id}`}
                      >
                        {day(b.periodStart)} – {day(b.periodEnd)}
                      </Link>
                    </td>
                    <td>{label(b.type)}</td>
                    <td>
                      <Badge value={b.status} />
                    </td>
                    <td>{b.totals.lines}</td>
                    <td>{rupees(b.totals.amount)}</td>
                    <td>{rupees(b.totals.paid.amount)}</td>
                    <td>{rupees(b.totals.failed.amount)}</td>
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

function download(filename: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function LineActions({ batchId, line }: { batchId: string; line: AdminPayoutLine }) {
  const [utr, setUtr] = useState('');
  const utrOk = /^[A-Za-z0-9]{6,40}$/.test(utr.trim());
  return (
    <span className="space-x-2 whitespace-nowrap">
      <ActionDialog
        label="Mark paid"
        variant="primary"
        title={`Mark ${line.payee.name ?? 'payout'} paid`}
        description={`${rupees(line.amount)} to ${line.bank ? `${line.bank.holderName} · ${line.bank.accountMasked}` : 'the payee'}.`}
        confirmLabel="Mark paid"
        ready={utrOk}
        onConfirm={(reason) =>
          admin.payouts.markPaid(batchId, line.id, { utr: utr.trim(), reason })
        }
      >
        <Field
          label="Bank reference (UTR)"
          value={utr}
          onChange={(e) => setUtr(e.target.value)}
          hint="6–40 letters and digits"
        />
      </ActionDialog>
      {line.status === 'PENDING' && (
        <ActionDialog
          label="Mark failed"
          variant="danger"
          title={`Mark ${line.payee.name ?? 'payout'} failed`}
          confirmLabel="Mark failed"
          onConfirm={(reason) => admin.payouts.markFailed(batchId, line.id, reason)}
        />
      )}
    </span>
  );
}

export function PayoutBatchPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['payouts', id], queryFn: () => admin.payouts.get(id) });
  const [exportError, setExportError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);
  return (
    <Loader query={q}>
      {(b) => {
        const executable = ['APPROVED', 'PROCESSING', 'PARTIALLY_FAILED'].includes(b.status);
        return (
          <div className="space-y-4">
            <PageHeader
              back={{ to: '/payouts', label: 'Payout batches' }}
              title={`${label(b.type)} payouts · ${day(b.periodStart)} – ${day(b.periodEnd)}`}
              subtitle={<Badge value={b.status} />}
              actions={
                <>
                  {b.status === 'DRAFT' && can('payout:approve') && (
                    <ActionDialog
                      label="Approve batch"
                      variant="primary"
                      description="Someone other than the batch’s creator must approve it."
                      confirmLabel="Approve"
                      onConfirm={(reason) => admin.payouts.approve(id, reason)}
                    />
                  )}
                  {b.status !== 'DRAFT' && can('payout:approve') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={exporting}
                      onClick={async () => {
                        setExporting(true);
                        setExportError(null);
                        try {
                          const file = await admin.payouts.export(id);
                          download(file.filename, file.csv, file.contentType);
                        } catch (e) {
                          setExportError(e);
                        } finally {
                          setExporting(false);
                        }
                      }}
                    >
                      Export bank file (CSV)
                    </Button>
                  )}
                </>
              }
            />
            <ServerError error={exportError} />
            <Section title="Totals">
              <Facts
                items={[
                  ['Lines', b.totals.lines],
                  ['Amount', rupees(b.totals.amount)],
                  ['Pending', `${b.totals.pending.lines} · ${rupees(b.totals.pending.amount)}`],
                  ['Paid', `${b.totals.paid.lines} · ${rupees(b.totals.paid.amount)}`],
                  ['Failed', `${b.totals.failed.lines} · ${rupees(b.totals.failed.amount)}`],
                  ['Approved', b.approvedAt ? dateTime(b.approvedAt) : '—'],
                ]}
              />
            </Section>
            <Section title="Lines">
              {b.lines.length === 0 ? (
                <Empty>No payable balances this week.</Empty>
              ) : (
                <Table head={['Payee', 'Bank', 'Amount', 'Cash deducted', 'Status', 'UTR', '']}>
                  {b.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.payee.name ?? l.payee.id.slice(0, 8)}</td>
                      <td>
                        {l.bank ? `${l.bank.accountMasked} · ${l.bank.ifsc}` : 'No bank account'}
                      </td>
                      <td>{rupees(l.amount)}</td>
                      <td>{rupees(l.cashDeduction)}</td>
                      <td>
                        <Badge value={l.status} />
                        {l.failureReason && (
                          <div className="text-xs text-red-700">{l.failureReason}</div>
                        )}
                      </td>
                      <td>{l.utr ?? '—'}</td>
                      <td>
                        {executable && l.status !== 'PAID' && can('payout:execute') && (
                          <LineActions batchId={id} line={l} />
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
          </div>
        );
      }}
    </Loader>
  );
}
