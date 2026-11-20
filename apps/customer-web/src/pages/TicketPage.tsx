import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { Alert, Button, ErrorState, Spinner, cn } from '@fos/ui';
import { Section, ServerError, TextArea } from '../components/ui';
import { customer } from '../lib/customer';
import { dayTime } from '../lib/format';
import { CATEGORY, StatusPill, ticketsKey } from './SupportPage';

/** A support ticket's conversation and reply box (API-SUP-006/007). */
export function TicketPage() {
  const { ticketId = '' } = useParams();
  const created = Boolean((useLocation().state as { created?: boolean } | null)?.created);
  const qc = useQueryClient();
  const key = ['support', 'ticket', ticketId];
  const ticket = useQuery({
    queryKey: key,
    queryFn: () => customer.support.ticket(ticketId),
    refetchInterval: 60_000,
  });
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!reply.trim()) {
      setError(new Error('Write a message first.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(key, await customer.support.reply(ticketId, { body: reply.trim() }));
      setReply('');
      void qc.invalidateQueries({ queryKey: ticketsKey });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (ticket.isPending)
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading your request" />
      </div>
    );
  if (ticket.isError)
    return (
      <ErrorState
        title="Couldn’t load this request"
        description={ticket.error.message}
        action={<Button onClick={() => void ticket.refetch()}>Try again</Button>}
      />
    );
  const t = ticket.data;
  const closed = t.status === 'RESOLVED' || t.status === 'CLOSED';
  return (
    <div className="space-y-4">
      <Link to="/help" className="text-sm font-medium text-brand-700 underline">
        ← All requests
      </Link>
      {created && (
        <Alert tone="success" title="We have received your request">
          Ticket {t.number}. We’ll reply here and notify you.
        </Alert>
      )}
      <header className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-xl font-bold text-gray-900">{t.subject}</h1>
          <StatusPill status={t.status} />
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {t.number} · {CATEGORY[t.category] ?? t.category} · opened {dayTime(t.createdAt)}
          {t.orderId && (
            <>
              {' '}
              ·{' '}
              <Link to={`/orders/${t.orderId}`} className="underline">
                View order
              </Link>
            </>
          )}
        </p>
      </header>
      <Section title="Conversation">
        <ol className="space-y-3" aria-label="Messages">
          {t.messages.map((m) => (
            <li
              key={m.id}
              className={cn(
                'max-w-[85%] rounded-xl px-3 py-2 text-sm',
                m.from === 'YOU'
                  ? 'ml-auto bg-brand-50 text-gray-900'
                  : m.from === 'SYSTEM'
                    ? 'mx-auto bg-gray-50 text-center text-gray-600'
                    : 'bg-gray-100 text-gray-900',
              )}
            >
              <p className="text-xs font-medium text-gray-600">
                {m.from === 'YOU' ? 'You' : m.from === 'SYSTEM' ? 'Update' : 'Support'} ·{' '}
                {dayTime(m.at)}
              </p>
              <p className="whitespace-pre-wrap">{m.body}</p>
              {m.attachments.length > 0 && (
                <p className="text-xs text-gray-500">
                  {m.attachments.length} attachment{m.attachments.length > 1 ? 's' : ''}
                </p>
              )}
            </li>
          ))}
        </ol>
        {closed ? (
          <p className="mt-4 text-sm text-gray-600">
            This request is {t.status === 'RESOLVED' ? 'resolved' : 'closed'}. Start a new request
            if you still need help.
          </p>
        ) : (
          <form className="mt-4 space-y-2" onSubmit={send} noValidate aria-label="Reply">
            <TextArea
              label="Your reply"
              maxLength={5000}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
            <ServerError error={error} />
            <div className="flex justify-end">
              <Button type="submit" loading={busy}>
                Send reply
              </Button>
            </div>
          </form>
        )}
      </Section>
    </div>
  );
}
