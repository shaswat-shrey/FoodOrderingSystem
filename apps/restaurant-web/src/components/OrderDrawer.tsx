import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveEvent } from '@fos/api-client';
import { Alert, Button, Spinner } from '@fos/ui';
import { clock, label, rupees } from '../lib/format';
import { live } from '../lib/live';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';
import { ServerError } from './fields';

const HANDOVER_STATES = new Set(['PREPARING', 'READY_FOR_PICKUP']);

interface PartnerLive {
  firstName: string | null;
  vehicleType?: string | null;
  stage: 'ASSIGNED' | 'ARRIVED' | 'PICKED_UP';
  at: string;
}

/**
 * FR-RORD-009: one order's details, with the partner who is coming for it (live from
 * `delivery.partner_assigned` / `partner_arrived` / `picked_up`) and the handover step
 * against the partner's pickup code (FR-RORD-007, API-RORD-009).
 */
export function OrderDrawer({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { can } = useWorkspace();
  const qc = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const order = useQuery({
    queryKey: ['orders', 'details', orderId],
    queryFn: () => merchant.orders.get(orderId),
  });
  const [partnerLive, setPartnerLive] = useState<PartnerLive | null>(null);
  useLiveEvent(
    live,
    ['delivery.partner_assigned', 'delivery.partner_arrived', 'delivery.picked_up'],
    (env) => {
      const d = env.data as {
        orderId?: string;
        partner?: { firstName?: string; vehicleType?: string | null } | string | null;
      };
      if (d.orderId !== orderId) return;
      const p = d.partner;
      const firstName = typeof p === 'string' ? p : (p?.firstName ?? null);
      setPartnerLive((prev) => ({
        firstName: firstName ?? prev?.firstName ?? null,
        vehicleType: typeof p === 'object' && p ? p.vehicleType : prev?.vehicleType,
        stage:
          env.event === 'delivery.partner_assigned'
            ? 'ASSIGNED'
            : env.event === 'delivery.partner_arrived'
              ? 'ARRIVED'
              : 'PICKED_UP',
        at: env.occurredAt,
      }));
      void qc.invalidateQueries({ queryKey: ['orders', 'details', orderId] });
    },
  );

  useEffect(() => {
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const o = order.data;
  const p = o?.partner;
  const stage: PartnerLive['stage'] | null =
    partnerLive?.stage ??
    (p ? (p.pickedUpAt ? 'PICKED_UP' : p.arrivedAt ? 'ARRIVED' : 'ASSIGNED') : null);
  const partnerName = partnerLive?.firstName ?? p?.firstName ?? null;
  const assigned = Boolean(stage);
  const canHandover =
    o &&
    assigned &&
    stage !== 'PICKED_UP' &&
    HANDOVER_STATES.has(o.status) &&
    can('rest.order:handover');

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-drawer-title"
        className="h-full w-full max-w-md overflow-y-auto bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <h2
            id="order-drawer-title"
            ref={heading}
            tabIndex={-1}
            className="font-mono text-lg font-semibold"
          >
            {o ? `Order ${o.number}` : 'Order'}
          </h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {order.isPending && <Spinner />}
        <ServerError error={order.error} />
        {o && (
          <div className="mt-3 space-y-4 text-sm">
            <p>
              <span className="font-semibold">{label(o.status)}</span> · {o.customer} ·{' '}
              {o.payment === 'COD' ? 'Cash on delivery' : 'Paid'}
              {o.readyBy && <> · ready by {clock(o.readyBy)}</>}
            </p>
            <ul className="space-y-1">
              {o.items.map((i, n) => (
                <li key={n}>
                  <span className="font-semibold">{i.quantity} ×</span> {i.name}
                  {i.variant ? ` (${i.variant})` : ''}
                  {i.options.length > 0 && (
                    <span className="text-gray-600"> — {i.options.join(', ')}</span>
                  )}
                </li>
              ))}
            </ul>
            {o.value && (
              <p className="text-gray-700">
                Items {rupees(o.value.itemsSubtotal)} · your share {rupees(o.value.restaurantShare)}{' '}
                after {rupees(o.value.commission)} commission
              </p>
            )}

            <section aria-labelledby="partner-heading" className="rounded-lg bg-gray-50 p-3">
              <h3 id="partner-heading" className="font-semibold">
                Delivery partner
              </h3>
              <p aria-live="polite" className="mt-1">
                {!stage && 'Looking for a delivery partner…'}
                {stage === 'ASSIGNED' &&
                  `${partnerName ?? 'A partner'} is on the way${p?.assignedAt ? ` (assigned ${clock(p.assignedAt)})` : ''}.`}
                {stage === 'ARRIVED' &&
                  `${partnerName ?? 'The partner'} has arrived${p?.arrivedAt || partnerLive ? ` at ${clock(p?.arrivedAt ?? partnerLive?.at)}` : ''}. Ask for their pickup code.`}
                {stage === 'PICKED_UP' &&
                  `${partnerName ?? 'The partner'} has picked up the order.`}
              </p>
            </section>

            {canHandover && <Handover orderId={o.id} partnerName={partnerName} />}

            <section aria-labelledby="timeline-heading">
              <h3 id="timeline-heading" className="font-semibold">
                Timeline
              </h3>
              <ol className="mt-1 space-y-1">
                {o.timeline.map((t, n) => (
                  <li key={n} className="flex justify-between gap-2">
                    <span>{label(t.status)}</span>
                    <span className="tabular-nums text-gray-600">{clock(t.at)}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Handover({ orderId, partnerName }: { orderId: string; partnerName: string | null }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const handover = useMutation({
    mutationFn: () => merchant.orders.handover(orderId, code),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['kds'] });
    },
  });
  if (handover.isSuccess)
    return (
      <Alert tone="success">
        Handed over to {handover.data.partner ?? partnerName ?? 'the partner'}.
      </Alert>
    );
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d{4}$/.test(code)) handover.mutate();
      }}
    >
      <label className="block">
        <span className="font-medium">Partner’s pickup code</span>
        <input
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
          className="mt-1 block h-11 w-32 rounded-md border border-gray-300 px-3 font-mono text-lg tracking-widest"
        />
        <span className="mt-1 block text-xs text-gray-600">
          The 4-digit code on the partner’s app.
        </span>
      </label>
      <ServerError error={handover.error} />
      <Button type="submit" disabled={code.length !== 4} loading={handover.isPending}>
        Hand over order
      </Button>
    </form>
  );
}
