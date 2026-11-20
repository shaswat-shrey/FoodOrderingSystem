import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import type {
  AdminTicket,
  AdminTicketCategory,
  AdminTicketPriority,
  AdminTicketStatus,
} from '@fos/api-client';
import { useAuth } from '@fos/auth-web';
import { Button, cn } from '@fos/ui';
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
  TextArea,
} from '../components/ui';
import { admin } from '../lib/admin';
import { dateTime, label, rupees } from '../lib/format';
import { useOpsLive } from '../lib/live';
import { usePermissions } from '../lib/permissions';

const STATUSES: AdminTicketStatus[] = [
  'OPEN',
  'PENDING_CUSTOMER',
  'PENDING_INTERNAL',
  'RESOLVED',
  'CLOSED',
];
const PRIORITIES: AdminTicketPriority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
const CATEGORIES: AdminTicketCategory[] = [
  'ORDER_ISSUE',
  'PAYMENT',
  'REFUND',
  'ACCOUNT',
  'DELIVERY',
  'FEEDBACK',
  'OTHER',
];
type Queue = 'ALL' | 'UNASSIGNED' | 'MINE' | 'OVERDUE';

export function SupportPage() {
  useOpsLive();
  const [params, setParams] = useSearchParams();
  const queue = (params.get('queue') as Queue | null) ?? 'ALL';
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['tickets', queue, status, priority, category, search, page],
    queryFn: () =>
      admin.tickets.list({
        queue: queue === 'ALL' ? undefined : queue,
        status: (status || undefined) as AdminTicketStatus | undefined,
        priority: (priority || undefined) as AdminTicketPriority | undefined,
        category: (category || undefined) as AdminTicketCategory | undefined,
        q: search.trim() || undefined,
        page,
      }),
  });
  return (
    <div>
      <PageHeader title="Support desk" subtitle="Most urgent and soonest-due first." />
      <Tabs
        tabs={[
          { key: 'ALL', label: 'All open' },
          { key: 'UNASSIGNED', label: 'Unassigned' },
          { key: 'MINE', label: 'Mine' },
          { key: 'OVERDUE', label: 'Overdue' },
        ]}
        value={queue}
        onChange={(k) => {
          setParams({ queue: k });
          setPage(1);
        }}
      />
      <Filters>
        <Field
          label="Search"
          type="search"
          placeholder="Ticket or order number, subject"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={STATUSES} any="Open statuses" />
        </Select>
        <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
          <Options values={PRIORITIES} any="Any priority" />
        </Select>
        <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <Options values={CATEGORIES} any="Any category" />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No tickets in this queue.</Empty>
          ) : (
            <>
              <Table
                head={['Ticket', 'Priority', 'Status', 'Requester', 'Assignee', 'Due', 'Updated']}
              >
                {p.data.map((t) => (
                  <tr key={t.id} className={cn(t.overdue && 'bg-red-50')}>
                    <td>
                      <Link
                        to={`/support/${t.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {t.number}
                      </Link>
                      <div className="text-xs text-gray-600">{t.subject}</div>
                      <div className="text-xs text-gray-500">
                        {label(t.category)}
                        {t.order ? ` · ${t.order.number}` : ''}
                      </div>
                    </td>
                    <td>
                      <Badge value={t.priority} />
                    </td>
                    <td>
                      <Badge value={t.status} />
                    </td>
                    <td>
                      {t.requester.fullName}
                      <div className="text-xs text-gray-500">{label(t.requester.type)}</div>
                    </td>
                    <td>{t.assignee?.fullName ?? '—'}</td>
                    <td className={cn(t.overdue && 'font-semibold text-red-700')}>
                      {dateTime(t.slaDueAt)}
                    </td>
                    <td>{dateTime(t.updatedAt)}</td>
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

function Composer({ ticketId }: { ticketId: string }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState<false | 'reply' | 'note'>(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  const send = async (internal: boolean) => {
    setBusy(internal ? 'note' : 'reply');
    setError(null);
    try {
      await admin.tickets.message(ticketId, { body: body.trim(), internal });
      setBody('');
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <TextArea
        label="Message"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={5000}
      />
      <ServerError error={error} />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!body.trim()}
          loading={busy === 'reply'}
          onClick={() => void send(false)}
        >
          Reply to requester
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!body.trim()}
          loading={busy === 'note'}
          onClick={() => void send(true)}
        >
          Add internal note
        </Button>
      </div>
    </div>
  );
}

function TicketControls({ t }: { t: AdminTicket }) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const [error, setError] = useState<unknown>(null);
  const [assignee, setAssignee] = useState('');
  const qc = useQueryClient();
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select
          label="Status"
          value={t.status}
          onChange={(e) =>
            void run(() =>
              admin.tickets.update(t.id, { status: e.target.value as AdminTicketStatus }),
            )
          }
        >
          <Options values={STATUSES} />
        </Select>
        <Select
          label="Priority"
          value={t.priority}
          onChange={(e) =>
            void run(() =>
              admin.tickets.update(t.id, { priority: e.target.value as AdminTicketPriority }),
            )
          }
        >
          <Options values={PRIORITIES} />
        </Select>
        <Select
          label="Category"
          value={t.category}
          onChange={(e) =>
            void run(() =>
              admin.tickets.update(t.id, { category: e.target.value as AdminTicketCategory }),
            )
          }
        >
          <Options values={CATEGORIES} />
        </Select>
      </div>
      <div className="flex flex-wrap gap-2">
        {can('support:assign') && user && t.assignee?.id !== user.id && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void run(() => admin.tickets.assign(t.id, user.id))}
          >
            Assign to me
          </Button>
        )}
        {can('support:assign') && t.assignee && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void run(() => admin.tickets.assign(t.id, null))}
          >
            Unassign
          </Button>
        )}
        <ActionDialog
          label="Escalate"
          variant="danger"
          title={`Escalate ${t.number}`}
          description="Raises the priority and hands the ticket to a senior agent."
          confirmLabel="Escalate"
          onConfirm={(reason) => admin.tickets.escalate(t.id, reason, assignee.trim() || undefined)}
        >
          <Field
            label="Assign to (user id, optional)"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          />
        </ActionDialog>
      </div>
      <ServerError error={error} />
    </div>
  );
}

export function TicketPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['tickets', id], queryFn: () => admin.tickets.get(id) });
  return (
    <Loader query={q}>
      {(t) => (
        <div className="space-y-4">
          <PageHeader
            back={{ to: '/support', label: 'Support desk' }}
            title={`${t.number} · ${t.subject}`}
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <Badge value={t.status} /> <Badge value={t.priority} /> {label(t.category)} · due{' '}
                {dateTime(t.slaDueAt)} ·{' '}
                {t.assignee ? `assigned to ${t.assignee.fullName}` : 'unassigned'}
              </span>
            }
          />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <Section title="Conversation">
                <ol className="space-y-3">
                  {t.messages.map((m) => (
                    <li
                      key={m.id}
                      className={cn(
                        'rounded-lg border p-3 text-sm',
                        m.internal ? 'border-amber-200 bg-amber-50' : 'border-gray-200',
                      )}
                    >
                      <div className="mb-1 flex flex-wrap justify-between gap-2 text-xs text-gray-500">
                        <span>
                          {m.author?.fullName ?? label(m.authorType)}
                          {m.internal ? ' · internal note' : ''}
                        </span>
                        <span>{dateTime(m.at)}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-gray-900">{m.body}</p>
                    </li>
                  ))}
                </ol>
                <div className="mt-4">
                  <Composer ticketId={t.id} />
                </div>
              </Section>
            </div>
            <div className="space-y-4">
              <Section title="Ticket">
                <TicketControls t={t} />
              </Section>
              <Section title="Requester">
                <Facts
                  items={[
                    [
                      'Name',
                      <Link
                        key="u"
                        className="text-brand-700 hover:underline"
                        to={`/users/${t.requester.id}`}
                      >
                        {t.requester.fullName}
                      </Link>,
                    ],
                    ['Type', label(t.requester.type)],
                    ['Phone', t.requester.phone],
                    ['Orders', t.requester.orders],
                    ['Open tickets', t.requester.openTickets],
                  ]}
                />
              </Section>
              {t.order && (
                <Section title="Order">
                  <Facts
                    items={[
                      [
                        'Order',
                        <Link
                          key="o"
                          className="text-brand-700 hover:underline"
                          to={`/orders/${t.order.id}`}
                        >
                          {t.order.number}
                        </Link>,
                      ],
                      ['Status', <Badge key="s" value={t.order.status} />],
                      ['Restaurant', `${t.order.restaurant} · ${t.order.branch.name}`],
                      ['Total', `${rupees(t.order.totalAmount)} (${label(t.order.paymentMethod)})`],
                      ['Delivered', dateTime(t.order.deliveredAt)],
                    ]}
                  />
                </Section>
              )}
            </div>
          </div>
        </div>
      )}
    </Loader>
  );
}
