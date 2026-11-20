import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PartnerApplication, VehicleType } from '@fos/api-client';
import { Alert, Button, Spinner } from '@fos/ui';
import { Field, Section, Select, ServerError } from '../components/ui';
import { partner } from '../lib/partner';

const key = ['partner', 'profile'] as const;
const VEHICLES: [VehicleType, string][] = [
  ['MOTORCYCLE', 'Motorcycle'],
  ['SCOOTER', 'Scooter'],
  ['E_BIKE', 'E-bike'],
  ['BICYCLE', 'Bicycle'],
];
const MOTORIZED = new Set<VehicleType>(['MOTORCYCLE', 'SCOOTER']);
const vehicleName = (t: VehicleType) => VEHICLES.find(([v]) => v === t)?.[1] ?? t;
const plain = (s: string) => s.toLowerCase().replaceAll('_', ' ');

/** FR-DP-004/005 (API-DP-007…012): emergency contact, preferred zone and vehicles. */
export function ProfilePage() {
  const profile = useQuery({ queryKey: key, queryFn: partner.profile.get });
  if (profile.isPending) return <Spinner />;
  if (profile.isError) return <ServerError error={profile.error} />;
  const p = profile.data;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Profile</h1>
      <Section title="You">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-gray-500">Name</dt>
            <dd className="font-medium">{p.legalName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Account</dt>
            <dd className="font-medium">{plain(p.accountStatus)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-gray-500">
          Name, date of birth and ID documents can only be changed by our support team.
        </p>
      </Section>
      <EmergencyContact profile={p} />
      <PreferredZone profile={p} />
      <Vehicles profile={p} />
    </div>
  );
}

function useSave() {
  const qc = useQueryClient();
  return (next: PartnerApplication) => qc.setQueryData(key, next);
}

function EmergencyContact({ profile }: { profile: PartnerApplication }) {
  const saved = useSave();
  const [form, setForm] = useState(
    profile.emergencyContact ?? { name: '', relation: '', phone: '' },
  );
  const save = useMutation({
    mutationFn: () =>
      partner.profile.update({
        emergencyContact: {
          name: form.name.trim(),
          relation: form.relation.trim(),
          phone: form.phone.trim(),
        },
      }),
    onSuccess: saved,
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Section title="Emergency contact">
      <p className="mb-2 text-sm text-gray-600">
        We call this person only if something happens to you on a trip.
      </p>
      <form onSubmit={submit} className="grid gap-3">
        <Field
          label="Contact name"
          value={form.name}
          onChange={set('name')}
          required
          minLength={2}
        />
        <Field
          label="Relation"
          placeholder="e.g. Brother"
          value={form.relation}
          onChange={set('relation')}
          required
          minLength={2}
        />
        <Field
          label="Contact phone"
          type="tel"
          inputMode="tel"
          placeholder="+91…"
          value={form.phone}
          onChange={set('phone')}
          required
        />
        <ServerError error={save.error} />
        {save.isSuccess && <Alert tone="success">Emergency contact saved.</Alert>}
        <Button type="submit" loading={save.isPending}>
          Save contact
        </Button>
      </form>
    </Section>
  );
}

function PreferredZone({ profile }: { profile: PartnerApplication }) {
  const saved = useSave();
  const zones = useQuery({ queryKey: ['partner', 'zones'], queryFn: partner.zones });
  const [zone, setZone] = useState(profile.homeZone?.id ?? '');
  const save = useMutation({
    mutationFn: () => partner.profile.update({ homeZoneId: zone }),
    onSuccess: saved,
  });
  return (
    <Section title="Preferred zone">
      <div className="grid gap-3">
        <Select label="Zone" value={zone} onChange={(e) => setZone(e.target.value)}>
          <option value="" disabled>
            Choose a zone
          </option>
          {(zones.data ?? []).map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}, {z.city}
            </option>
          ))}
        </Select>
        <ServerError error={save.error ?? zones.error} />
        {save.isSuccess && <Alert tone="success">Preferred zone saved.</Alert>}
        <Button
          variant="secondary"
          disabled={!zone || zone === profile.homeZone?.id}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save zone
        </Button>
      </div>
    </Section>
  );
}

function Vehicles({ profile }: { profile: PartnerApplication }) {
  const saved = useSave();
  const [type, setType] = useState<VehicleType>('MOTORCYCLE');
  const [registration, setRegistration] = useState('');
  const act = useMutation({
    mutationFn: (fn: () => Promise<PartnerApplication>) => fn(),
    onSuccess: saved,
  });
  const add = (e: FormEvent) => {
    e.preventDefault();
    act.mutate(async () => {
      const next = await partner.profile.addVehicle({
        type,
        registrationNumber: MOTORIZED.has(type) ? registration.trim() : null,
      });
      setRegistration('');
      return next;
    });
  };
  return (
    <Section title="Vehicles">
      <ul className="divide-y divide-gray-100" aria-label="Your vehicles">
        {profile.vehicles.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <span>
              <span className="font-medium">{vehicleName(v.type)}</span>
              {v.registrationNumber && ` · ${v.registrationNumber}`}
              <span className="block text-xs text-gray-500">{plain(v.status)}</span>
            </span>
            {v.isActive ? (
              <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-semibold text-green-800">
                In use
              </span>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={v.status !== 'VERIFIED' || act.isPending}
                onClick={() => act.mutate(() => partner.profile.activateVehicle(v.id))}
              >
                Use this vehicle
              </Button>
            )}
          </li>
        ))}
        {profile.vehicles.length === 0 && (
          <li className="py-2 text-sm text-gray-600">No vehicles yet.</li>
        )}
      </ul>
      <ServerError error={act.error} />
      <form onSubmit={add} className="mt-3 grid gap-3 border-t border-gray-100 pt-3">
        <h3 className="text-sm font-semibold">Add a vehicle</h3>
        <Select
          label="Vehicle type"
          value={type}
          onChange={(e) => setType(e.target.value as VehicleType)}
        >
          {VEHICLES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        {MOTORIZED.has(type) && (
          <Field
            label="Registration number"
            placeholder="KA01AB1234"
            autoCapitalize="characters"
            value={registration}
            onChange={(e) => setRegistration(e.target.value)}
            required
          />
        )}
        <p className="text-xs text-gray-500">
          New vehicles are checked before you can use them. Go offline before switching.
        </p>
        <Button type="submit" variant="secondary" loading={act.isPending}>
          Add vehicle
        </Button>
      </form>
    </Section>
  );
}
