import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { SupportCategory, SupportTicketStatus } from '@fos/api-client';
import { Button, EmptyState, ErrorState, Spinner, cn } from '@fos/ui';
import { LoadMore, PageTitle, PhotoPicker } from '../components/account-ui';
import { Field, Section, Select, ServerError, TextArea } from '../components/ui';
import { customer } from '../lib/customer';
import { dayTime } from '../lib/format';

export const CATEGORY: Record<SupportCategory, string> = {
  ORDER_ISSUE: 'Problem with an order',
  PAYMENT: 'Payment',
  REFUND: 'Refund',
  ACCOUNT: 'My account',
  DELIVERY: 'Delivery',
  FEEDBACK: 'Feedback',
  OTHER: 'Something else',
};
export const TICKET_STATUS: Record<SupportTicketStatus, string> = {
  OPEN: 'Open',
  PENDING_CUSTOMER: 'Waiting for you',
  PENDING_INTERNAL: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};
export const ticketsKey = ['support', 'tickets'];

/** Help & support: my tickets and a new request (API-SUP-003…005). */
export function SupportPage() {
  const [params] = useSearchParams();
  const linkedOrder = params.get('orderId');
  const [creating, setCreating] = useState(Boolean(linkedOrder));
  const tickets = useInfiniteQuery({
    queryKey: ticketsKey,
    queryFn: ({ pageParam }) => customer.support.tickets(pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = tickets.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="space-y-4">
      <PageTitle
        aside={!creating && <Button onClick={() => setCreating(true)}>New request</Button>}
      >
        Help & support
      </PageTitle>
      {creating && <NewTicket defaultOrderId={linkedOrder} onCancel={() => setCreating(false)} />}
      <Section title="Your requests">
        {tickets.isPending ? (
          <Spinner label="Loading requests" />
        ) : tickets.isError ? (
          <ErrorState
            title="Couldn’t load your requests"
            description={tickets.error.message}
            action={<Button onClick={() => void tickets.refetch()}>Try again</Button>}
          />
        ) : rows.length === 0 ? (
          <EmptyState title="No requests yet" description="Ask us anything — we’re here to help." />
        ) : (
          <ul className="divide-y divide-gray-100" aria-label="Support requests">
            {rows.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/help/tickets/${t.id}`}
                  className="flex min-h-11 items-start justify-between gap-3 py-2 hover:bg-gray-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-gray-900">{t.subject}</span>
                    <span className="text-xs text-gray-500">
                      {t.number} · {CATEGORY[t.category] ?? t.category} · {dayTime(t.updatedAt)}
                    </span>
                  </span>
                  <StatusPill status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        <LoadMore
          hasMore={Boolean(tickets.hasNextPage)}
          loading={tickets.isFetchingNextPage}
          onClick={() => void tickets.fetchNextPage()}
        />
      </Section>
    </div>
  );
}

export function StatusPill({ status }: { status: SupportTicketStatus }) {
  const done = status === 'RESOLVED' || status === 'CLOSED';
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'PENDING_CUSTOMER'
          ? 'bg-amber-50 text-warning-600'
          : done
            ? 'bg-gray-100 text-gray-700'
            : 'bg-brand-50 text-brand-800',
      )}
    >
      {TICKET_STATUS[status] ?? status}
    </span>
  );
}

function NewTicket({
  defaultOrderId,
  onCancel,
}: {
  defaultOrderId: string | null;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const recent = useQuery({
    queryKey: ['orders', 'history', 'ALL', 'first'],
    queryFn: () => customer.orders.history({ limit: 10 }),
  });
  const [form, setForm] = useState({
    category: (defaultOrderId ? 'ORDER_ISSUE' : 'OTHER') as SupportCategory,
    orderId: defaultOrderId ?? '',
    subject: '',
    description: '',
  });
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [descError, setDescError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const orders = recent.data?.data ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.description.trim().length < 10) {
      setDescError('Tell us a little more (at least 10 characters).');
      return;
    }
    setDescError(undefined);
    setBusy(true);
    setError(null);
    try {
      const ticket = await customer.support.create({
        category: form.category,
        description: form.description.trim(),
        ...(form.subject.trim().length >= 3 ? { subject: form.subject.trim() } : {}),
        ...(form.orderId ? { orderId: form.orderId } : {}),
        ...(files.length ? { attachmentFileIds: files.map((f) => f.id) } : {}),
      });
      void qc.invalidateQueries({ queryKey: ticketsKey });
      navigate(`/help/tickets/${ticket.id}`, { state: { created: true } });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="New request">
      <form className="space-y-3" onSubmit={submit} noValidate aria-label="New request">
        <Select
          label="What do you need help with?"
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value as SupportCategory })}
        >
          {(Object.keys(CATEGORY) as SupportCategory[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY[c]}
            </option>
          ))}
        </Select>
        <Select
          label="Related order (optional)"
          value={form.orderId}
          onChange={(e) => setForm({ ...form, orderId: e.target.value })}
        >
          <option value="">No order</option>
          {defaultOrderId && !orders.some((o) => o.id === defaultOrderId) && (
            <option value={defaultOrderId}>This order</option>
          )}
          {orders.map((o) => (
            <option key={o.id} value={o.id}>
              {o.number} · {o.restaurant.name}
            </option>
          ))}
        </Select>
        <Field
          label="Subject (optional)"
          maxLength={200}
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
        <TextArea
          label="Message"
          rows={4}
          maxLength={5000}
          value={form.description}
          error={descError}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <PhotoPicker
          label="Attach photos (optional)"
          purpose="SUPPORT_ATTACHMENT"
          value={files}
          onChange={setFiles}
        />
        <ServerError error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Send request
          </Button>
        </div>
      </form>
    </Section>
  );
}
