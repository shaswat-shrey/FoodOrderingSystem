import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChangeRequestBody, ChangeRequestType, RestaurantProfile } from '@fos/api-client';
import { Alert, Button, EmptyState, Spinner } from '@fos/ui';
import { Field, Section, Select, ServerError } from '../components/fields';
import { needsReauth, ReauthPrompt } from '../components/Reauth';
import { day, label } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

export const CHANGE_TYPES: [ChangeRequestType, string][] = [
  ['LEGAL_NAME', 'Legal name'],
  ['PAN', 'PAN'],
  ['GSTIN', 'GSTIN'],
  ['FSSAI', 'FSSAI licence'],
  ['BANK_ACCOUNT', 'Bank account'],
];

/** FR-REST-010, FR-RFIN-003 (API-MER-008…013): the restaurant's profile and legal details. */
export function ProfilePage() {
  const { restaurant, can } = useWorkspace();
  const rid = restaurant?.id ?? '';
  const profile = useQuery({
    queryKey: ['restaurant', rid, 'profile'],
    queryFn: () => merchant.restaurant.get(rid),
    enabled: Boolean(rid && can('rest.restaurant:read')),
  });
  if (!restaurant) return null;
  if (!can('rest.restaurant:read'))
    return <EmptyState title="Ask your manager for access to the restaurant profile" />;
  if (profile.isError) return <ServerError error={profile.error} />;
  if (!profile.data) return <Spinner />;
  const p = profile.data;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{p.brandName}</h1>
      {p.rating && (
        <p className="text-sm text-gray-700">
          {p.rating.average.toFixed(1)} ★ from {p.rating.count} ratings
        </p>
      )}
      <ProfileForm profile={p} editable={can('rest.restaurant:update')} />
      {can('rest.restaurant:update') && <Images profile={p} />}
      <Legal profile={p} canRequest={can('rest.restaurant:legal')} />
    </div>
  );
}

function ProfileForm({ profile, editable }: { profile: RestaurantProfile; editable: boolean }) {
  const qc = useQueryClient();
  const cuisines = useQuery({
    queryKey: ['cuisines'],
    queryFn: merchant.cuisines,
    enabled: editable,
  });
  const [description, setDescription] = useState(profile.description ?? '');
  const [email, setEmail] = useState(profile.contactEmail ?? '');
  const [phone, setPhone] = useState(profile.contactPhone ?? '');
  const [pureVeg, setPureVeg] = useState(profile.pureVeg);
  const [chosen, setChosen] = useState(profile.cuisines.map((c) => c.id));
  const save = useMutation({
    mutationFn: () =>
      merchant.restaurant.update(profile.id, {
        description: description.trim() || null,
        ...(email.trim() ? { contactEmail: email.trim() } : {}),
        ...(phone.trim() ? { contactPhone: phone.trim() } : {}),
        pureVeg,
        ...(chosen.length ? { cuisineIds: chosen } : {}),
      }),
    onSuccess: (next) => qc.setQueryData(['restaurant', profile.id, 'profile'], next),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Section title="Profile">
      <form onSubmit={submit} className="space-y-3">
        <fieldset disabled={!editable} className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm md:col-span-2">
            <span className="font-medium text-gray-800">About the restaurant</span>
            <textarea
              value={description}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 block min-h-20 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <Field
            label="Contact email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            label="Contact phone"
            type="tel"
            placeholder="+91…"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pureVeg}
              onChange={(e) => setPureVeg(e.target.checked)}
            />
            Pure-veg restaurant
          </label>
          {editable && cuisines.data && (
            <fieldset className="md:col-span-2">
              <legend className="text-sm font-medium text-gray-800">Cuisines (up to 5)</legend>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {cuisines.data.map((c) => (
                  <label key={c.id} className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={chosen.includes(c.id)}
                      disabled={!chosen.includes(c.id) && chosen.length >= 5}
                      onChange={() =>
                        setChosen((x) =>
                          x.includes(c.id) ? x.filter((i) => i !== c.id) : [...x, c.id],
                        )
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {!editable && (
            <p className="text-sm text-gray-700">
              Cuisines: {profile.cuisines.map((c) => c.name).join(', ') || '—'}
            </p>
          )}
        </fieldset>
        <ServerError error={save.error} />
        {save.isSuccess && <Alert tone="success">Profile saved.</Alert>}
        {editable && (
          <Button type="submit" loading={save.isPending}>
            Save profile
          </Button>
        )}
      </form>
    </Section>
  );
}

function Images({ profile }: { profile: RestaurantProfile }) {
  const qc = useQueryClient();
  const upload = useMutation({
    mutationFn: async ({ kind, file }: { kind: 'logo' | 'cover'; file: File }) => {
      const f = await merchant.upload(
        file,
        kind === 'logo' ? 'RESTAURANT_LOGO' : 'RESTAURANT_COVER',
        file.name,
      );
      return merchant.restaurant.setImage(profile.id, kind, f.id);
    },
    onSuccess: (next) => qc.setQueryData(['restaurant', profile.id, 'profile'], next),
  });
  return (
    <Section title="Logo and cover photo">
      <div className="grid gap-4 md:grid-cols-2">
        {(['logo', 'cover'] as const).map((kind) => {
          const img = profile[kind];
          const src = img?.urls?.card ?? img?.urls?.thumb ?? img?.urls?.hero;
          return (
            <div key={kind} className="text-sm">
              <p className="font-medium">{kind === 'logo' ? 'Logo' : 'Cover photo'}</p>
              {src ? (
                <img
                  src={src}
                  alt={`Current ${kind}`}
                  className={`mt-1 rounded object-cover ${kind === 'logo' ? 'h-20 w-20' : 'h-24 w-full'}`}
                />
              ) : (
                <p className="mt-1 text-gray-600">None yet.</p>
              )}
              <label className="mt-2 block">
                <span className="sr-only">Upload a new {kind}</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={upload.isPending}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) upload.mutate({ kind, file });
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          );
        })}
      </div>
      <ServerError error={upload.error} />
    </Section>
  );
}

function Legal({ profile, canRequest }: { profile: RestaurantProfile; canRequest: boolean }) {
  const requests = useQuery({
    queryKey: ['restaurant', profile.id, 'change-requests'],
    queryFn: () => merchant.restaurant.changeRequests(profile.id),
  });
  return (
    <Section title="Legal, tax and bank details">
      <dl className="grid gap-2 text-sm md:grid-cols-2">
        <Row k="Legal name" v={`${profile.legalName} (${label(profile.entityType)})`} />
        <Row k="PAN" v={profile.panMasked ?? '—'} />
        <Row k="GSTIN" v={profile.gstin ?? 'Not registered'} />
        <Row
          k="FSSAI"
          v={
            profile.fssaiNumber
              ? `${profile.fssaiNumber}, valid until ${day(profile.fssaiExpiresOn)}`
              : '—'
          }
        />
        <Row
          k="Bank account"
          v={
            profile.bank
              ? `${profile.bank.holderName} · ${profile.bank.accountMasked} · ${profile.bank.ifsc} (${label(profile.bank.status)})`
              : 'None on file'
          }
        />
      </dl>
      <p className="mt-2 text-sm text-gray-600">
        Changes to these details are checked by our team before they apply.
      </p>
      {requests.data && requests.data.length > 0 && (
        <div className="mt-3">
          <h3 className="text-sm font-semibold">Change requests</h3>
          <ul className="mt-1 divide-y divide-gray-100 text-sm" aria-label="Change requests">
            {requests.data.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 py-1">
                <span>
                  {CHANGE_TYPES.find(([t]) => t === r.type)?.[1] ?? r.type} · sent{' '}
                  {day(r.createdAt)}
                </span>
                <span className="font-medium">
                  {label(r.status)}
                  {r.reason && <span className="font-normal text-gray-600"> — {r.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {canRequest && (
        <ChangeRequestForm restaurantId={profile.id} pending={profile.pendingChanges} />
      )}
    </Section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-gray-600">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

const FIELDS: Record<ChangeRequestType, [string, string, string?][]> = {
  LEGAL_NAME: [['legalName', 'New legal name']],
  PAN: [['pan', 'PAN']],
  GSTIN: [['gstin', 'GSTIN']],
  FSSAI: [
    ['fssaiNumber', 'FSSAI licence number'],
    ['fssaiExpiresOn', 'Valid until', 'date'],
  ],
  BANK_ACCOUNT: [
    ['holderName', 'Account holder name'],
    ['accountNumber', 'Account number'],
    ['ifsc', 'IFSC'],
  ],
};

/** API-MER-010: one pending request per type; values go to admin review, never echoed back. */
export function ChangeRequestForm({
  restaurantId,
  pending,
}: {
  restaurantId: string;
  pending: ChangeRequestType[];
}) {
  const qc = useQueryClient();
  const [type, setType] = useState<ChangeRequestType>('BANK_ACCOUNT');
  const [values, setValues] = useState<Record<string, string>>({});
  const [needsCode, setNeedsCode] = useState(false);
  const send = useMutation({
    mutationFn: () =>
      merchant.restaurant.requestChange(restaurantId, {
        type,
        values: Object.fromEntries(FIELDS[type].map(([k]) => [k, (values[k] ?? '').trim()])),
      } as ChangeRequestBody),
    onSuccess: () => {
      setValues({});
      setNeedsCode(false);
      void qc.invalidateQueries({ queryKey: ['restaurant', restaurantId] });
    },
    onError: (e) => {
      if (needsReauth(e)) setNeedsCode(true);
    },
  });
  const blocked = pending.includes(type);
  const complete = FIELDS[type].every(([k]) => (values[k] ?? '').trim());
  return (
    <form
      className="mt-4 space-y-3 border-t border-gray-100 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (complete && !blocked) send.mutate();
      }}
    >
      <h3 className="text-sm font-semibold">Request a change</h3>
      <div className="grid gap-3 md:grid-cols-3">
        <Select
          label="What to change"
          value={type}
          onChange={(e) => {
            setType(e.target.value as ChangeRequestType);
            setValues({});
          }}
        >
          {CHANGE_TYPES.map(([t, l]) => (
            <option key={t} value={t}>
              {l}
            </option>
          ))}
        </Select>
        {FIELDS[type].map(([k, l, inputType]) => (
          <Field
            key={k}
            label={l}
            type={inputType ?? 'text'}
            autoComplete="off"
            value={values[k] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
          />
        ))}
      </div>
      {blocked && (
        <Alert tone="warning">A change of this kind is already waiting for verification.</Alert>
      )}
      {needsCode ? (
        <ReauthPrompt busy={send.isPending} onConfirmed={() => send.mutate()} />
      ) : (
        <ServerError error={send.error} />
      )}
      {send.isSuccess && <Alert tone="success">Sent for verification.</Alert>}
      {!needsCode && (
        <Button type="submit" disabled={!complete || blocked} loading={send.isPending}>
          Send for verification
        </Button>
      )}
    </form>
  );
}
