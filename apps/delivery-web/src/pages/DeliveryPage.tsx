import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiClientError, type ActiveDelivery, type Point } from '@fos/api-client';
import { Alert, Button, Spinner } from '@fos/ui';
import { Field, Section, Select, ServerError } from '../components/ui';
import { rupees, STAGE_LABEL } from '../lib/format';
import { currentFix } from '../lib/location';
import { usePartnerLive } from '../lib/live';
import { partner } from '../lib/partner';

const key = ['partner', 'delivery'] as const;

/** Best effort: the server falls back to the last reported location. */
const here = (): Promise<Point | undefined> =>
  currentFix()
    .then((f) => ({ lat: f.lat, lng: f.lng }))
    .catch(() => undefined);

const mapsLink = (p: Point) =>
  `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`;

/** FR-DEL-010…035: the trip, one step at a time. */
export function DeliveryPage() {
  const { connected } = usePartnerLive();
  const delivery = useQuery({
    queryKey: key,
    queryFn: partner.deliveries.active,
    // Stage changes made elsewhere (restaurant handover) arrive as delivery.status_changed
    // (EVT-DP-016); polling is only the fallback, a little brisker while at the restaurant.
    refetchInterval: (q) =>
      !connected ? 15_000 : q.state.data?.status === 'AT_RESTAURANT' ? 30_000 : 60_000,
  });
  if (delivery.isPending) return <Spinner />;
  if (delivery.isError) return <ServerError error={delivery.error} />;
  if (!delivery.data)
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold text-gray-900">No delivery in progress</h1>
        <Link to="/" className="text-brand-700 underline">
          Back to your shift
        </Link>
      </div>
    );
  return <Trip d={delivery.data} />;
}

function Trip({ d }: { d: ActiveDelivery }) {
  const qc = useQueryClient();
  const update = (next: ActiveDelivery) => {
    qc.setQueryData(key, next);
    void qc.invalidateQueries({ queryKey: ['partner', 'availability'] });
  };
  const beforePickup = d.status === 'ASSIGNED' || d.status === 'AT_RESTAURANT';
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-gray-500">Order {d.orderNumber}</p>
        <h1 className="text-2xl font-bold text-gray-900">{STAGE_LABEL[d.status] ?? d.status}</h1>
      </div>

      {d.status === 'DELIVERED' ? (
        <Section title="Delivered">
          <p className="text-gray-800">
            Nice work. You earned {rupees(d.earning?.total)}
            {d.earning?.tip ? `, including a ${rupees(d.earning.tip)} tip` : ''}.
          </p>
          <Link to="/" className="mt-3 inline-block text-brand-700 underline">
            Back to your shift
          </Link>
        </Section>
      ) : (
        <>
          <Section title={beforePickup ? 'Pickup' : 'Drop'}>
            {beforePickup ? (
              <div className="space-y-1 text-sm text-gray-800">
                <p className="font-semibold">
                  {d.restaurant.name}, {d.restaurant.branch}
                </p>
                <p>{d.restaurant.address}</p>
                {d.restaurant.phone && (
                  <a href={`tel:${d.restaurant.phone}`} className="text-brand-700 underline">
                    Call restaurant
                  </a>
                )}
                <p>{d.items} item(s)</p>
                {d.restaurant.location && (
                  <a
                    href={mapsLink(d.restaurant.location)}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-brand-700 underline"
                  >
                    Navigate
                  </a>
                )}
              </div>
            ) : (
              <div className="space-y-1 text-sm text-gray-800">
                <p className="font-semibold">{d.customer.name}</p>
                <p>{d.customer.address}</p>
                {d.customer.instructions && (
                  <p className="text-gray-600">“{d.customer.instructions}”</p>
                )}
                {d.customer.location && (
                  <a
                    href={mapsLink(d.customer.location)}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-brand-700 underline"
                  >
                    Navigate
                  </a>
                )}
              </div>
            )}
          </Section>
          {d.pickupCode && beforePickup && (
            <Section title="Pickup code">
              <p className="text-sm text-gray-600">Show this to the restaurant at handover.</p>
              <p
                className="mt-1 text-3xl font-bold tracking-widest text-gray-900"
                aria-label="Pickup code"
              >
                {d.pickupCode}
              </p>
            </Section>
          )}
          <Step d={d} onDone={update} />
          {beforePickup && <Unassign d={d} />}
        </>
      )}
    </div>
  );
}

function Step({ d, onDone }: { d: ActiveDelivery; onDone: (d: ActiveDelivery) => void }) {
  const [far, setFar] = useState(false);
  const arrive = useMutation({
    mutationFn: async (confirm: boolean) => {
      const at = await here();
      const body = { ...(at ? { at } : {}), ...(confirm ? { confirm } : {}) };
      return d.status === 'ASSIGNED'
        ? partner.deliveries.arrivedAtRestaurant(d.id, body)
        : partner.deliveries.arrivedAtCustomer(d.id, body);
    },
    onSuccess: (next) => {
      setFar(false);
      onDone(next);
    },
    onError: (e) => {
      // BR-DEL-013: outside the geofence the partner must confirm (and is flagged).
      if (isApiClientError(e) && e.code === 'GEOFENCE_CONFIRMATION_REQUIRED') setFar(true);
    },
  });
  const pickUp = useMutation({
    mutationFn: async () => {
      const at = await here();
      return partner.deliveries.pickedUp(d.id, at ? { at } : {});
    },
    onSuccess: onDone,
  });

  if (d.status === 'ASSIGNED' || d.status === 'EN_ROUTE_TO_CUSTOMER') {
    const where = d.status === 'ASSIGNED' ? 'restaurant' : 'customer';
    return (
      <Section title="Next step">
        {far ? (
          <Alert tone="warning" title={`You seem to be far from the ${where}`}>
            Confirm only if you are really there; this is recorded.
            <div className="mt-2 flex gap-2">
              <Button size="sm" loading={arrive.isPending} onClick={() => arrive.mutate(true)}>
                Yes, I’m here
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setFar(false)}>
                Not yet
              </Button>
            </div>
          </Alert>
        ) : (
          <>
            {!(
              isApiClientError(arrive.error) &&
              arrive.error.code === 'GEOFENCE_CONFIRMATION_REQUIRED'
            ) && <ServerError error={arrive.error} />}
            <Button
              className="w-full"
              loading={arrive.isPending}
              onClick={() => arrive.mutate(false)}
            >
              {`Arrived at the ${where}`}
            </Button>
          </>
        )}
      </Section>
    );
  }
  if (d.status === 'AT_RESTAURANT')
    return (
      <Section title="Next step">
        <p className="mb-2 text-sm text-gray-700">
          Check the order number and seal before leaving.
        </p>
        <ServerError error={pickUp.error} />
        <Button className="w-full" loading={pickUp.isPending} onClick={() => pickUp.mutate()}>
          Picked up the order
        </Button>
      </Section>
    );
  if (d.status === 'AT_CUSTOMER') return <Complete d={d} onDone={onDone} />;
  return null;
}

function Complete({ d, onDone }: { d: ActiveDelivery; onDone: (d: ActiveDelivery) => void }) {
  const [otp, setOtp] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [cash, setCash] = useState(false);
  const cod = d.payment.type === 'COD';
  const complete = useMutation({
    mutationFn: async () => {
      const at = await here();
      const base = { ...(at ? { at } : {}), ...(cod ? { cashCollected: cash } : {}) };
      if (d.proof === 'PHOTO') {
        if (!photo) throw new Error('Take a photo of the order at the door.');
        const { id } = await partner.upload(photo, 'DELIVERY_PROOF', photo.name);
        return partner.deliveries.complete(d.id, { method: 'PHOTO', photoFileId: id, ...base });
      }
      return partner.deliveries.complete(d.id, { method: 'OTP', otp, ...base });
    },
    onSuccess: onDone,
  });
  const unreachable = useMutation({
    mutationFn: () => partner.deliveries.customerUnreachable(d.id, { callAttempts: 2 }),
    onSuccess: onDone,
  });
  const ready = (d.proof === 'PHOTO' ? Boolean(photo) : /^\d{4}$/.test(otp)) && (!cod || cash);
  return (
    <Section title="Hand over">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          complete.mutate();
        }}
      >
        {d.proof === 'OTP' ? (
          <Field
            label="Delivery code from the customer"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          />
        ) : (
          <label className="block text-sm">
            <span className="font-medium text-gray-800">Photo of the order at the door</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="mt-1 block"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            />
          </label>
        )}
        {cod && (
          <label className="flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} />
            {`I collected ${rupees(d.payment.type === 'COD' ? d.payment.collect : 0)} in cash`}
          </label>
        )}
        <ServerError error={complete.error ?? unreachable.error} />
        <Button type="submit" className="w-full" disabled={!ready} loading={complete.isPending}>
          Complete delivery
        </Button>
      </form>
      <Button
        variant="ghost"
        className="mt-2 w-full"
        loading={unreachable.isPending}
        onClick={() => unreachable.mutate()}
      >
        Customer not reachable
      </Button>
    </Section>
  );
}

function Unassign({ d }: { d: ActiveDelivery }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<'ACCIDENT' | 'VEHICLE_BREAKDOWN' | 'EMERGENCY' | 'OTHER'>(
    'VEHICLE_BREAKDOWN',
  );
  const unassign = useMutation({
    mutationFn: () => partner.deliveries.unassign(d.id, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner'] }),
  });
  if (!open)
    return (
      <Button variant="ghost" className="w-full" onClick={() => setOpen(true)}>
        I can’t do this delivery
      </Button>
    );
  return (
    <Section title="Give this delivery back">
      <p className="mb-2 text-sm text-gray-700">
        We will find another partner. Giving deliveries back often affects your offers.
      </p>
      <Select
        label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value as typeof reason)}
      >
        <option value="VEHICLE_BREAKDOWN">Vehicle breakdown</option>
        <option value="ACCIDENT">Accident</option>
        <option value="EMERGENCY">Personal emergency</option>
        <option value="OTHER">Other</option>
      </Select>
      <ServerError error={unassign.error} />
      <div className="mt-3 flex gap-2">
        <Button variant="danger" loading={unassign.isPending} onClick={() => unassign.mutate()}>
          Give it back
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </Section>
  );
}
