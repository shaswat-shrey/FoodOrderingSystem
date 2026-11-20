import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '@fos/auth-web';
import type { LatLng } from '@fos/api-client';
import { Alert, Button, Spinner } from '@fos/ui';
import { Field, Section, ServerError } from '../components/ui';
import { customer } from '../lib/customer';
import { SERVICEABILITY_TEXT } from '../lib/format';
import { currentPosition, setDeliveryLocation, type DeliveryLocation } from '../lib/location';

/** Choose where to deliver: a saved address, the current position, a search, or a pin (FR-LOC-001…004). */
export function LocationPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';
  const signedIn = useAuth().status === 'signedIn';
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({ lat: '', lng: '', area: '' });
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => customer.addresses.list(),
    enabled: signedIn,
  });
  const suggestions = useQuery({
    queryKey: ['geo', 'autocomplete', debounced],
    queryFn: () => customer.geo.autocomplete(debounced),
    enabled: debounced.length >= 3,
  });

  /** Checks serviceability, then saves the location and moves on (or explains why not). */
  async function choose(point: LatLng, label: string, addressId?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const s = await customer.geo.serviceability(point);
      const location: DeliveryLocation = { ...point, label, addressId: addressId ?? null };
      setDeliveryLocation(location);
      if (!s.serviceable) {
        setNotice(
          `${SERVICEABILITY_TEXT[s.reason ?? 'OUTSIDE_ZONE'] ?? SERVICEABILITY_TEXT.OUTSIDE_ZONE} You can still browse, or pick another location.`,
        );
        return;
      }
      navigate(next);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function locateMe() {
    setBusy(true);
    setError(null);
    try {
      const point = await currentPosition();
      const reverse = await customer.geo.reverse(point).catch(() => null);
      await choose(
        point,
        reverse?.address?.area || reverse?.address?.formatted || 'Current location',
      );
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  function submitManual(e: FormEvent) {
    e.preventDefault();
    const lat = Number(manual.lat);
    const lng = Number(manual.lng);
    if (
      !manual.lat ||
      !manual.lng ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      setError(new Error('Enter a valid latitude and longitude.'));
      return;
    }
    void choose({ lat, lng }, manual.area.trim() || `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Where should we deliver?</h1>
      <div aria-live="polite" className="space-y-2">
        {notice && <Alert tone="warning">{notice}</Alert>}
        <ServerError error={error} />
      </div>

      <Button className="w-full" size="lg" onClick={() => void locateMe()} loading={busy}>
        Use my current location
      </Button>

      {signedIn && (
        <Section title="Saved addresses">
          {addresses.isPending ? (
            <Spinner label="Loading addresses" />
          ) : addresses.data && addresses.data.length > 0 ? (
            <ul className="divide-y divide-gray-100">
              {addresses.data.map((a) => {
                const label = `${a.customLabel ?? a.label[0] + a.label.slice(1).toLowerCase()} · ${a.area}`;
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      className="flex min-h-11 w-full flex-col items-start py-2 text-left hover:bg-gray-50"
                      onClick={() => void choose(a.location, label, a.id)}
                      disabled={busy}
                    >
                      <span className="font-medium text-gray-900">{label}</span>
                      <span className="text-sm text-gray-600">
                        {a.line1}, {a.area}, {a.city}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-gray-600">
              No saved addresses yet. You can add one at checkout.
            </p>
          )}
        </Section>
      )}

      <Section title="Search for an area">
        <Field
          label="Area, street or landmark"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
        {suggestions.data && suggestions.data.length > 0 && (
          <ul className="mt-2 divide-y divide-gray-100" aria-label="Suggestions">
            {suggestions.data.map((s) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  className="flex min-h-11 w-full flex-col items-start py-2 text-left hover:bg-gray-50"
                  onClick={async () => {
                    try {
                      const place = await customer.geo.place(s.placeId);
                      await choose({ lat: place.lat, lng: place.lng }, place.area || s.title);
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  <span className="font-medium text-gray-900">{s.title}</span>
                  <span className="text-sm text-gray-600">{s.subtitle}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Enter coordinates">
        <form className="space-y-3" onSubmit={submitManual} noValidate>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Latitude"
              inputMode="decimal"
              value={manual.lat}
              onChange={(e) => setManual({ ...manual, lat: e.target.value })}
            />
            <Field
              label="Longitude"
              inputMode="decimal"
              value={manual.lng}
              onChange={(e) => setManual({ ...manual, lng: e.target.value })}
            />
          </div>
          <Field
            label="Area name"
            hint="Shown in the header, e.g. Koramangala"
            value={manual.area}
            onChange={(e) => setManual({ ...manual, area: e.target.value })}
          />
          <Button type="submit" variant="secondary" loading={busy}>
            Use this location
          </Button>
        </form>
      </Section>
    </div>
  );
}
