import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import {
  isApiClientError,
  useLiveEvent,
  useLiveReconnect,
  useLiveStatus,
  useLiveSubscription,
  type CancelReasonCode,
  type CancellationPreview,
  type CustomerOrderStatus,
  type LiveEnvelope,
  type OrderTracking,
  type PartnerCard,
} from '@fos/api-client';
import { Alert, Button, DietaryMarker, EmptyState, ErrorState, Spinner, cn } from '@fos/ui';
import { OrderAfterCare } from '../components/OrderAfterCare';
import { Dialog, Row, Section, Select, ServerError } from '../components/ui';
import { customer } from '../lib/customer';
import { ago, clock, rupees, VEHICLE_LABEL } from '../lib/format';
import { useIdempotencyKey } from '../lib/idempotency';
import { live } from '../lib/live';

const STAGES: { status: CustomerOrderStatus; label: string }[] = [
  { status: 'PLACED', label: 'Order placed' },
  { status: 'ACCEPTED', label: 'Restaurant accepted' },
  { status: 'PREPARING', label: 'Preparing your food' },
  { status: 'READY_FOR_PICKUP', label: 'Ready for pickup' },
  { status: 'PICKED_UP', label: 'On the way' },
  { status: 'DELIVERED', label: 'Delivered' },
];
const ENDED: Record<string, string> = {
  CANCELLED: 'This order was cancelled',
  REJECTED: 'The restaurant couldn’t accept this order',
  FAILED: 'This order couldn’t be completed',
};
const HEADLINE: Record<CustomerOrderStatus, string> = {
  PAYMENT_PENDING: 'Waiting for payment',
  PLACED: 'Order placed — waiting for the restaurant',
  ACCEPTED: 'Restaurant accepted your order',
  PREPARING: 'Preparing your food',
  READY_FOR_PICKUP: 'Ready for pickup',
  PICKED_UP: 'On the way',
  DELIVERED: 'Delivered — enjoy your meal!',
  CANCELLED: 'Cancelled',
  REJECTED: 'Restaurant couldn’t accept',
  FAILED: 'Order failed',
};
const DELIVERY_LABEL: Record<string, string> = {
  SEARCHING: 'Finding a delivery partner',
  ASSIGNED: 'Your delivery partner is heading to the restaurant',
  AT_RESTAURANT: 'Your delivery partner is at the restaurant',
  EN_ROUTE_TO_CUSTOMER: 'Your delivery partner is on the way to you',
  AT_CUSTOMER: 'Your delivery partner has arrived',
};
const REASON_LABEL: Record<CancelReasonCode, string> = {
  CHANGED_MIND: 'I changed my mind',
  ORDERED_BY_MISTAKE: 'I ordered by mistake',
  DELAY: 'It’s taking too long',
  ADDRESS_ISSUE: 'Wrong address',
  PAYMENT_ISSUE: 'Payment problem',
  OTHER: 'Something else',
};
const CANCELLABLE = new Set([
  'PAYMENT_PENDING',
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
]);
const TERMINAL = new Set(['DELIVERED', 'CANCELLED', 'REJECTED', 'FAILED']);
/** FR-TRK-005 */
const STALE_SECONDS = 60;

type EtaPayload = { min?: string; max?: string; minAt?: string; maxAt?: string } | null;
const toEta = (eta: EtaPayload | undefined): OrderTracking['eta'] | undefined => {
  if (eta === undefined) return undefined;
  if (!eta) return null;
  const minAt = eta.minAt ?? eta.min;
  const maxAt = eta.maxAt ?? eta.max;
  return minAt && maxAt ? { minAt, maxAt } : null;
};

function useNow(ms = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Order confirmation and live tracking (FR-CORD-003…007, FR-TRK-005; API-TRK-001/002). */
export function OrderPage() {
  const { orderId = '' } = useParams();
  const placed = Boolean((useLocation().state as { placed?: boolean } | null)?.placed);
  const qc = useQueryClient();
  const trackingKey = ['order', orderId, 'tracking'];
  const status = useLiveStatus(live);
  const connected = status === 'connected';
  const [liveEta, setLiveEta] = useState<{ minutes: number; km: number } | null>(null);

  const tracking = useQuery({
    queryKey: trackingKey,
    queryFn: () => customer.tracking.snapshot(orderId),
    // Polling fallback: slow while the socket is up, faster without it (FR-RT-022).
    refetchInterval: (q) =>
      q.state.data && TERMINAL.has(q.state.data.status) ? false : connected ? 30_000 : 10_000,
  });
  const details = useQuery({
    queryKey: ['order', orderId, 'details'],
    queryFn: () => customer.orders.details(orderId),
  });
  const pollLocation = Boolean(tracking.data?.live) && !connected;
  const location = useQuery({
    queryKey: ['order', orderId, 'location'],
    queryFn: () => customer.tracking.location(orderId),
    enabled: pollLocation,
    refetchInterval: pollLocation ? 10_000 : false,
  });
  useEffect(() => {
    const fix = location.data?.location;
    if (fix)
      qc.setQueryData<OrderTracking>(['order', orderId, 'tracking'], (t) =>
        t ? { ...t, location: fix } : t,
      );
  }, [location.data, qc, orderId]);

  useLiveSubscription(live, 'order', orderId);
  useLiveReconnect(live, () => void qc.invalidateQueries({ queryKey: ['order', orderId] }));

  const patch = (fn: (t: OrderTracking) => OrderTracking) =>
    qc.setQueryData<OrderTracking>(['order', orderId, 'tracking'], (t) => (t ? fn(t) : t));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['order', orderId] });

  useLiveEvent(
    live,
    [
      'order.status_changed',
      'order.cancelled',
      'order.eta_updated',
      'delivery.partner_assigned',
      'delivery.status_changed',
      'delivery.partner_unassigned',
      'tracking.location',
      'tracking.eta',
      'tracking.stale',
    ],
    (env: LiveEnvelope) => {
      const d = env.data as Record<string, unknown>;
      // The user room also carries other orders' events.
      if (typeof d.orderId === 'string' && d.orderId !== orderId) return;
      if (env.event.startsWith('order.') && !d.orderId && env.aggregate?.id !== orderId) return;
      switch (env.event) {
        case 'order.status_changed': {
          const eta = toEta(d.eta as EtaPayload | undefined);
          patch((t) => ({
            ...t,
            status: d.to as CustomerOrderStatus,
            ...(eta !== undefined ? { eta } : {}),
          }));
          void qc.invalidateQueries({ queryKey: ['order', orderId, 'details'] });
          break;
        }
        case 'order.cancelled':
          refresh();
          break;
        case 'order.eta_updated': {
          const eta = toEta(d.eta as EtaPayload);
          if (eta !== undefined) patch((t) => ({ ...t, eta }));
          break;
        }
        case 'delivery.partner_assigned':
          patch((t) => ({
            ...t,
            partner: (d.partner as PartnerCard | null) ?? t.partner,
            live: true,
            delivery: t.delivery ? { ...t.delivery, status: 'ASSIGNED' } : t.delivery,
          }));
          // The delivery code is only in the snapshot.
          void qc.invalidateQueries({ queryKey: trackingKey });
          break;
        case 'delivery.status_changed':
          patch((t) => ({
            ...t,
            delivery: t.delivery ? { ...t.delivery, status: String(d.status) } : t.delivery,
          }));
          if (d.status === 'DELIVERED' || d.status === 'FAILED') refresh();
          break;
        case 'delivery.partner_unassigned':
          patch((t) => ({
            ...t,
            partner: null,
            live: false,
            location: null,
            deliveryCode: null,
            delivery: t.delivery ? { ...t.delivery, status: 'SEARCHING' } : t.delivery,
          }));
          setLiveEta(null);
          break;
        case 'tracking.location':
          patch((t) => ({
            ...t,
            location: {
              lat: Number(d.lat),
              lng: Number(d.lng),
              accuracyM: typeof d.accuracy === 'number' ? d.accuracy : null,
              recordedAt: String(d.recordedAt),
              ageSeconds: 0,
              stale: false,
            },
          }));
          break;
        case 'tracking.eta':
          setLiveEta({ minutes: Number(d.etaMinutes), km: Number(d.distanceRemainingKm) });
          break;
        case 'tracking.stale':
          patch((t) => (t.location ? { ...t, location: { ...t.location, stale: true } } : t));
          break;
      }
    },
  );

  if (tracking.isPending)
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading your order" />
      </div>
    );
  if (tracking.isError) {
    if (isApiClientError(tracking.error) && tracking.error.status === 404)
      return (
        <EmptyState
          title="Order not found"
          description="We couldn’t find this order on your account."
          action={
            <Link to="/" className="font-medium text-brand-700 underline">
              Go to home
            </Link>
          }
        />
      );
    return (
      <ErrorState
        title="Couldn’t load your order"
        description={tracking.error.message}
        action={<Button onClick={() => void tracking.refetch()}>Try again</Button>}
      />
    );
  }

  const t = tracking.data;
  const ended = ENDED[t.status];
  return (
    <div className="space-y-4">
      {placed && t.status !== 'PAYMENT_PENDING' && !ended && (
        <Alert tone="success" title="Order placed!">
          Order {t.number} is on its way to the restaurant.
        </Alert>
      )}
      <header className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <p className="text-sm text-gray-600">
          Order {t.number} · {t.restaurant.name}
        </p>
        <h1 className="mt-1 text-2xl font-bold text-gray-900" aria-live="polite" aria-atomic="true">
          {HEADLINE[t.status]}
        </h1>
        {!ended && t.status !== 'DELIVERED' && (
          <p className="mt-1 text-base text-gray-800" aria-live="polite">
            {liveEta && t.status === 'PICKED_UP'
              ? `About ${liveEta.minutes} min away · ${liveEta.km} km`
              : t.eta
                ? `Arriving ${clock(t.eta.minAt)}–${clock(t.eta.maxAt)}`
                : 'Calculating arrival time…'}
          </p>
        )}
        {!connected && !TERMINAL.has(t.status) && (
          <p className="mt-1 text-xs text-gray-500">
            Live updates paused — refreshing every few seconds.
          </p>
        )}
      </header>

      {t.status === 'PAYMENT_PENDING' && (
        <Alert tone="warning" title="Payment not completed">
          <Link to={`/orders/${orderId}/pay`} className="font-medium text-brand-700 underline">
            Complete payment
          </Link>
        </Alert>
      )}
      {ended && (
        <Alert tone="error" title={ended}>
          {details.data?.cancellation && details.data.cancellation.refundAmount > 0
            ? `${rupees(details.data.cancellation.refundAmount)} will be refunded.`
            : 'Any amount you paid will be refunded.'}
        </Alert>
      )}

      {!ended && t.status !== 'PAYMENT_PENDING' && (
        <Section title="Status">
          <Timeline status={t.status} times={details.data?.timeline ?? []} />
          {t.delivery && DELIVERY_LABEL[t.delivery.status] && t.status !== 'DELIVERED' && (
            <p className="mt-3 text-sm text-gray-700">{DELIVERY_LABEL[t.delivery.status]}</p>
          )}
        </Section>
      )}

      {t.partner && t.status !== 'DELIVERED' && (
        <Section title="Your delivery partner">
          <p className="font-medium text-gray-900">{t.partner.firstName}</p>
          <p className="text-sm text-gray-600">
            {[
              t.partner.vehicleType &&
                (VEHICLE_LABEL[t.partner.vehicleType] ?? t.partner.vehicleType),
              t.partner.rating != null && `★ ${t.partner.rating.toFixed(1)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {t.deliveryCode && (
            <p className="mt-3 rounded-lg bg-brand-50 p-3 text-sm text-brand-800">
              Share this code at delivery:{' '}
              <span className="text-xl font-bold tracking-widest tabular-nums">
                {t.deliveryCode}
              </span>
            </p>
          )}
          <PartnerLocation tracking={t} />
        </Section>
      )}

      {CANCELLABLE.has(t.status) && <CancelOrder orderId={orderId} />}

      {details.data && (
        <Section title="Order summary">
          <ul className="space-y-1 text-sm">
            {details.data.items.map((i) => (
              <li key={i.id} className="flex items-start gap-2">
                {i.dietaryMarker && (
                  <DietaryMarker type={i.dietaryMarker} size="sm" className="mt-1" />
                )}
                <span className="flex-1">
                  {i.quantity} × {i.itemName}
                  {i.variantName && ` (${i.variantName})`}
                </span>
                <span className="tabular-nums">{rupees(i.lineTotalAmount)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 text-sm">
            <Row label="Paid" value={rupees(details.data.breakdown.payable)} strong />
          </dl>
        </Section>
      )}

      {details.data && t.status !== 'PAYMENT_PENDING' && (
        <OrderAfterCare
          order={details.data}
          hasPartner={Boolean(t.partner || t.delivery?.deliveredAt)}
        />
      )}
    </div>
  );
}

function Timeline({
  status,
  times,
}: {
  status: CustomerOrderStatus;
  times: { status: CustomerOrderStatus; at: string }[];
}) {
  const current = STAGES.findIndex((s) => s.status === status);
  return (
    <ol className="space-y-2" aria-label="Order progress">
      {STAGES.map((s, i) => {
        const done = i <= current;
        const at = times.find((h) => h.status === s.status)?.at;
        return (
          <li
            key={s.status}
            className="flex items-center gap-3 text-sm"
            aria-current={i === current ? 'step' : undefined}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold',
                done ? 'bg-brand-700 text-white' : 'bg-gray-200 text-gray-500',
              )}
            >
              {done ? '✓' : i + 1}
            </span>
            <span className={cn('flex-1', done ? 'font-medium text-gray-900' : 'text-gray-500')}>
              {s.label}
              <span className="sr-only">{done ? ' (done)' : ' (pending)'}</span>
            </span>
            {at && <span className="tabular-nums text-gray-500">{clock(at)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function PartnerLocation({ tracking }: { tracking: OrderTracking }) {
  const now = useNow();
  const loc = tracking.location;
  if (!loc)
    return <p className="mt-3 text-sm text-gray-600">Waiting for the partner’s location…</p>;
  const age = Math.max(0, (now - new Date(loc.recordedAt).getTime()) / 1000);
  const stale = loc.stale || age > STALE_SECONDS;
  const maps = `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=16/${loc.lat}/${loc.lng}`;
  return (
    <div className="mt-3 rounded-lg border border-gray-200 p-3 text-sm">
      <p className="text-gray-800">
        Partner location:{' '}
        <span className="tabular-nums">
          {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
        </span>
      </p>
      <p className={stale ? 'text-warning-600' : 'text-gray-500'} role="status">
        {stale ? 'Location updating…' : `updated ${ago(age)}`}
      </p>
      <a
        href={maps}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex min-h-11 items-center font-medium text-brand-700 underline"
      >
        Open in maps
      </a>
    </div>
  );
}

function CancelOrder({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [reason, setReason] = useState<CancelReasonCode>('CHANGED_MIND');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const key = useIdempotencyKey();

  async function open() {
    setBusy(true);
    setError(null);
    try {
      setPreview(await customer.orders.cancellationPreview(orderId));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview?.quoteId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await customer.orders.cancel(
        orderId,
        { quoteId: preview.quoteId, reasonCode: reason },
        key(`${preview.quoteId}:${reason}`),
      );
      setPreview(null);
      setDone(
        result.cancellation.refund.amount > 0
          ? `Order cancelled. ${rupees(result.cancellation.refund.amount)} will be refunded.`
          : 'Order cancelled.',
      );
      await qc.invalidateQueries({ queryKey: ['order', orderId] });
    } catch (e) {
      setError(e);
      if (isApiClientError(e) && e.code === 'CANCELLATION_QUOTE_STALE') void open();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div aria-live="polite">
        {done && <Alert tone="success">{done}</Alert>}
        {!preview && <ServerError error={error} />}
      </div>
      <Button
        variant="secondary"
        className="w-full"
        loading={busy && !preview}
        onClick={() => void open()}
      >
        Cancel order
      </Button>
      {preview && (
        <Dialog
          title="Cancel this order?"
          onClose={() => setPreview(null)}
          footer={
            preview.allowed ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="secondary" onClick={() => setPreview(null)}>
                  Keep order
                </Button>
                <Button variant="danger" loading={busy} onClick={() => void confirm()}>
                  Cancel order
                </Button>
              </div>
            ) : undefined
          }
        >
          {preview.allowed ? (
            <div className="space-y-3 text-sm">
              <dl>
                <Row
                  label="Cancellation fee"
                  value={preview.fee > 0 ? rupees(preview.fee) : 'Free'}
                />
                <Row label="Refund" value={rupees(preview.refund.amount)} />
              </dl>
              {preview.refund.amount > 0 && (
                <p className="text-xs text-gray-500">{preview.refund.expectation}</p>
              )}
              {preview.freeUntil && preview.fee === 0 && (
                <p className="text-xs text-gray-500">
                  Free to cancel until {clock(preview.freeUntil)}.
                </p>
              )}
              <Select
                label="Reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as CancelReasonCode)}
              >
                {preview.reasons.map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABEL[r] ?? r}
                  </option>
                ))}
              </Select>
              <ServerError error={error} />
            </div>
          ) : (
            <p className="text-sm text-gray-700">
              This order can’t be cancelled any more. If something’s wrong, please contact support.
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
