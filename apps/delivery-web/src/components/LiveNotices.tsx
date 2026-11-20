import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveEvent, type LiveEnvelope } from '@fos/api-client';
import { live } from '../lib/live';

interface Notice {
  id: string;
  title: string;
  body: string;
  urgent: boolean;
}

const WITHDRAWN: Record<string, string> = {
  ORDER_CANCELLED: 'The customer’s order was cancelled.',
  PARTNER_OFFLINE: 'You went offline, so the offer went to someone else.',
};
const REVOKED: Record<string, string> = {
  ORDER_CANCELLED: 'The order was cancelled. Don’t pick it up.',
  RELEASED: 'It was handed to another partner.',
  NO_ACK: 'You didn’t confirm in time, so it went to another partner.',
  ADMIN: 'Our operations team reassigned it.',
};
const CANCELLED: Record<string, string> = {
  CUSTOMER_REQUEST: 'The customer cancelled it.',
  RESTAURANT_REJECTED: 'The restaurant couldn’t take it.',
  RESTAURANT_UNAVAILABLE: 'The restaurant couldn’t make it.',
  PAYMENT_FAILED: 'The payment didn’t go through.',
  NO_PARTNER: 'No delivery partner was found in time.',
};
const plain = (code: string) => code.toLowerCase().replaceAll('_', ' ');

/** EVT-DP-003/004/007/010: what changed under the partner, as a short notice. */
export function noticeFor(env: LiveEnvelope): Omit<Notice, 'id'> | null {
  const reason = typeof env.data.reason === 'string' ? env.data.reason : null;
  switch (env.event) {
    case 'offer.expired':
      return {
        title: 'Offer expired',
        body: 'The time to accept ran out. Stay online for the next one.',
        urgent: false,
      };
    case 'offer.withdrawn':
      return {
        title: 'Offer withdrawn',
        body: (reason && WITHDRAWN[reason]) ?? 'This order is no longer available.',
        urgent: false,
      };
    case 'assignment.revoked':
      return {
        title: 'Delivery taken off you',
        body:
          (reason && REVOKED[reason]) ??
          `This delivery is no longer yours${reason ? ` (${plain(reason)})` : ''}.`,
        urgent: true,
      };
    case 'order.cancelled':
      return {
        title: 'Order cancelled',
        body:
          (reason && CANCELLED[reason]) ??
          `Stop this delivery${reason ? ` — reason: ${plain(reason)}` : ''}.`,
        urgent: true,
      };
    default:
      return null;
  }
}

const EVENTS = ['offer.expired', 'offer.withdrawn', 'assignment.revoked', 'order.cancelled'];
const SHOW_MS = 10_000;

/**
 * Live notices for the partner (FR-RT, NFR-ACCESS-003): announced through aria-live
 * regions (assertive for trip-ending changes), dismissible, and gone after 10 s.
 */
export function LiveNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setNotices((all) => all.filter((n) => n.id !== id));
  }, []);
  useLiveEvent(live, EVENTS, (env) => {
    const n = noticeFor(env);
    if (!n) return;
    const id = env.eventId || `${env.event}-${Date.now()}`;
    setNotices((all) => (all.some((x) => x.id === id) ? all : [...all.slice(-2), { id, ...n }]));
    timers.current.set(
      id,
      setTimeout(() => dismiss(id), SHOW_MS),
    );
  });
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((x) => clearTimeout(x));
  }, []);

  const render = (urgent: boolean) =>
    notices
      .filter((n) => n.urgent === urgent)
      .map((n) => (
        <div
          key={n.id}
          className={`pointer-events-auto flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm shadow ${
            urgent ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
          }`}
        >
          <div>
            <p className="font-semibold text-gray-900">{n.title}</p>
            <p className="text-gray-800">{n.body}</p>
          </div>
          <button
            type="button"
            className="px-1 text-gray-600"
            aria-label={`Dismiss: ${n.title}`}
            onClick={() => dismiss(n.id)}
          >
            ×
          </button>
        </div>
      ));

  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-50 mx-auto max-w-xl space-y-2 px-4">
      <div role="alert" aria-live="assertive" className="space-y-2">
        {render(true)}
      </div>
      <div role="status" aria-live="polite" className="space-y-2">
        {render(false)}
      </div>
    </div>
  );
}
