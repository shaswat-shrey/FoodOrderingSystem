import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Availability, Offer, PartnerApplication } from '@fos/api-client';
import { Alert, Button, Spinner } from '@fos/ui';
import { Section, ServerError, Stat } from '../components/ui';
import { hoursMinutes, rupees } from '../lib/format';
import { currentFix, useLocationReporting } from '../lib/location';
import { partner } from '../lib/partner';
import { ApplicationPage, applicationKey, useApplication } from './ApplicationPage';

const STATE_LABEL: Record<string, string> = {
  OFFLINE: 'Offline',
  ONLINE_IDLE: 'Online — waiting for orders',
  OFFERED: 'New order offer',
  ON_DELIVERY: 'On a delivery',
  PAUSED: 'On a break',
};

/** Signed-in landing: the application until approved, then the shift screen. */
export function HomePage() {
  const application = useApplication();
  if (application.isPending) return <Spinner />;
  if (application.isError) return <ServerError error={application.error} />;
  if (application.data?.status !== 'APPROVED')
    return <ApplicationPage application={application.data ?? null} />;
  return <Shift application={application.data} />;
}

function Shift({ application }: { application: PartnerApplication }) {
  const qc = useQueryClient();
  const availability = useQuery({
    queryKey: ['partner', 'availability'],
    queryFn: partner.availability,
    refetchInterval: 15_000,
  });
  const dashboard = useQuery({
    queryKey: ['partner', 'dashboard'],
    queryFn: partner.dashboard,
    refetchInterval: 60_000,
  });
  const state = availability.data?.state;
  useLocationReporting(state);
  const set = (a: Availability) => {
    qc.setQueryData(['partner', 'availability'], a);
    void qc.invalidateQueries({ queryKey: ['partner', 'dashboard'] });
  };
  const online = useMutation({
    mutationFn: async () => partner.goOnline(await currentFix()),
    onSuccess: set,
  });
  const offline = useMutation({ mutationFn: partner.goOffline, onSuccess: set });
  const pause = useMutation({ mutationFn: partner.pause, onSuccess: set });
  const resume = useMutation({ mutationFn: partner.resume, onSuccess: set });
  const ack = useMutation({
    mutationFn: () => partner.application.acknowledgeGuidelines(application.guidelines.required),
    onSuccess: () => qc.invalidateQueries({ queryKey: applicationKey }),
  });

  const a = availability.data;
  const d = dashboard.data;
  const needsGuidelines = application.guidelines.acknowledged !== application.guidelines.required;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-900">Your shift</h1>
        {a && (
          <span
            className={
              a.state === 'OFFLINE'
                ? 'rounded-full bg-gray-200 px-3 py-1 text-sm text-gray-700'
                : 'rounded-full bg-green-100 px-3 py-1 text-sm text-success-600'
            }
          >
            {STATE_LABEL[a.state] ?? a.state}
          </span>
        )}
      </div>

      {needsGuidelines && (
        <Section title="Safety and conduct guidelines">
          <p className="text-sm text-gray-700">
            Wear a helmet, follow traffic rules, never ride while using the phone, and treat
            customers and restaurant staff with respect. Food must stay sealed until handover.
          </p>
          <ServerError error={ack.error} />
          <Button className="mt-3" loading={ack.isPending} onClick={() => ack.mutate()}>
            I have read and agree
          </Button>
        </Section>
      )}

      {a?.activeDeliveryId && (
        <Alert tone="info" title="You have a delivery in progress">
          <Link to="/delivery" className="font-semibold underline">
            Continue the delivery
          </Link>
        </Alert>
      )}

      {(state === 'ONLINE_IDLE' || state === 'OFFERED') && <OfferSlot />}

      <Section title="Availability">
        {availability.isPending && <Spinner />}
        {a && a.blockers.length > 0 && a.state === 'OFFLINE' && (
          <ul className="mb-3 list-disc pl-5 text-sm text-warning-600">
            {a.blockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
        )}
        {a?.offlineAfterCurrent && (
          <p className="mb-2 text-sm text-gray-700">You will go offline after this delivery.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {a?.state === 'OFFLINE' ? (
            <Button loading={online.isPending} onClick={() => online.mutate()}>
              Go online
            </Button>
          ) : (
            <Button
              variant="secondary"
              loading={offline.isPending}
              onClick={() => offline.mutate()}
            >
              Go offline
            </Button>
          )}
          {a?.state === 'ONLINE_IDLE' && (
            <>
              <Button variant="ghost" onClick={() => pause.mutate(15)}>
                Break 15 min
              </Button>
              <Button variant="ghost" onClick={() => pause.mutate(30)}>
                Break 30 min
              </Button>
            </>
          )}
          {a?.state === 'PAUSED' && (
            <Button variant="secondary" onClick={() => resume.mutate()}>
              End break
            </Button>
          )}
        </div>
        <ServerError error={online.error ?? offline.error ?? pause.error ?? resume.error} />
      </Section>

      <Section title="Today">
        {d ? (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Earnings" value={rupees(d.earnings)} />
            <Stat label="Deliveries" value={d.deliveries} />
            <Stat label="Online" value={hoursMinutes(d.onlineSeconds)} />
            <Stat label="Tips" value={rupees(d.tips)} />
          </div>
        ) : (
          <Spinner />
        )}
        {a && (
          <p className="mt-3 text-sm text-gray-600">
            Cash in hand {rupees(a.cashInHand)} of {rupees(a.cashCap)} limit.
          </p>
        )}
      </Section>
    </div>
  );
}

/** Polls for an offer while waiting (sockets arrive in Phase 10). */
function OfferSlot() {
  const offer = useQuery({
    queryKey: ['partner', 'offer'],
    queryFn: partner.offers.current,
    refetchInterval: 5_000,
  });
  if (!offer.data) return null;
  return <OfferCard offer={offer.data} />;
}

export function OfferCard({ offer }: { offer: Offer }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Count down against the server's clock, not the phone's.
  const [skew] = useState(() => new Date(offer.serverTime).getTime() - Date.now());
  const left = () =>
    Math.max(0, Math.round((new Date(offer.expiresAt).getTime() - (Date.now() + skew)) / 1000));
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    const t = setInterval(() => setSeconds(left()), 1000);
    return () => clearInterval(t);
  });
  const done = () => qc.invalidateQueries({ queryKey: ['partner'] });
  const accept = useMutation({
    mutationFn: () => partner.offers.accept(offer.offerId),
    onSuccess: async () => {
      await done();
      void navigate('/delivery');
    },
  });
  const reject = useMutation({
    mutationFn: (reason: 'TOO_FAR' | 'OTHER') => partner.offers.reject(offer.offerId, reason),
    onSuccess: done,
  });
  if (seconds === 0 && !accept.isPending) return null;
  return (
    <section
      aria-label="New order offer"
      className="rounded-xl border-2 border-brand-700 bg-white p-4 shadow"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">New delivery</h2>
        <span className="text-sm font-semibold text-brand-700" aria-live="polite">
          {seconds}s
        </span>
      </div>
      <dl className="mt-2 space-y-1 text-sm text-gray-800">
        <div>
          <dt className="inline text-gray-500">Pickup: </dt>
          <dd className="inline">
            {offer.restaurant.name}, {offer.restaurant.area} · {offer.restaurant.distanceKm} km away
          </dd>
        </div>
        <div>
          <dt className="inline text-gray-500">Drop: </dt>
          <dd className="inline">
            {offer.drop.area ?? 'Nearby'}
            {offer.drop.distanceKm != null && ` · ${offer.drop.distanceKm} km trip`}
          </dd>
        </div>
        <div>
          <dt className="inline text-gray-500">Items: </dt>
          <dd className="inline">{offer.items}</dd>
        </div>
        <div>
          <dt className="inline text-gray-500">Payment: </dt>
          <dd className="inline">
            {offer.payment.type === 'COD'
              ? `Collect cash ${rupees(offer.payment.collect)}`
              : 'Prepaid'}
          </dd>
        </div>
      </dl>
      <ServerError error={accept.error ?? reject.error} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          loading={reject.isPending}
          onClick={() => reject.mutate('TOO_FAR')}
        >
          Decline
        </Button>
        <Button loading={accept.isPending} onClick={() => accept.mutate()}>
          Accept
        </Button>
      </div>
    </section>
  );
}
