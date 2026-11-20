import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiClientError, type PartnerApplication } from '@fos/api-client';
import { Alert, Button, Spinner } from '@fos/ui';
import { Field, Section, Select, ServerError } from '../components/ui';
import { VEHICLE_LABEL } from '../lib/format';
import { partner } from '../lib/partner';

const DOCUMENTS: { type: string; label: string; motorOnly?: boolean; expiry?: boolean }[] = [
  { type: 'PAN', label: 'PAN card' },
  { type: 'ID_PROOF', label: 'ID proof (Aadhaar or passport)' },
  { type: 'BANK_PROOF', label: 'Bank proof (cancelled cheque or passbook)' },
  { type: 'DL_FRONT', label: 'Driving licence (front)', motorOnly: true, expiry: true },
  { type: 'DL_BACK', label: 'Driving licence (back)', motorOnly: true },
  { type: 'RC', label: 'Vehicle registration (RC)', motorOnly: true },
  { type: 'INSURANCE', label: 'Vehicle insurance', motorOnly: true },
];
const MOTORIZED = new Set(['MOTORCYCLE', 'SCOOTER']);

export const applicationKey = ['partner', 'application'] as const;

/** null = not started yet (the API answers 404). */
export function useApplication() {
  return useQuery({
    queryKey: applicationKey,
    queryFn: async () => {
      try {
        return await partner.application.get();
      } catch (error) {
        if (isApiClientError(error) && error.status === 404) return null;
        throw error;
      }
    },
  });
}

const STATUS_NOTE: Partial<
  Record<PartnerApplication['status'], { tone: 'info' | 'warning' | 'error'; text: string }>
> = {
  SUBMITTED: {
    tone: 'info',
    text: 'Submitted. We will review your documents within 2 working days.',
  },
  UNDER_REVIEW: { tone: 'info', text: 'Your application is being reviewed.' },
  CHANGES_REQUESTED: { tone: 'warning', text: 'Please fix the items below and submit again.' },
  REJECTED: { tone: 'error', text: 'Your application was not approved.' },
};

/** FR-DP-001…006: apply to deliver — details, vehicle, bank and documents, then submit. */
export function ApplicationPage({ application }: { application: PartnerApplication | null }) {
  const qc = useQueryClient();
  const refresh = (a: PartnerApplication) => qc.setQueryData(applicationKey, a);
  const start = useMutation({ mutationFn: partner.application.start, onSuccess: refresh });

  if (!application)
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-gray-900">Deliver with us</h1>
        <p className="text-gray-700">
          Earn per delivery plus tips, choose your own hours and get paid every week. You need to be
          18 or older, with a bicycle, e-bike, scooter or motorcycle.
        </p>
        <ServerError error={start.error} />
        <Button loading={start.isPending} onClick={() => start.mutate()}>
          Start my application
        </Button>
      </div>
    );

  const note = STATUS_NOTE[application.status];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Your application</h1>
      {note && (
        <Alert tone={note.tone}>
          {note.text}
          {application.rejectedReason && <> Reason: {application.rejectedReason}</>}
        </Alert>
      )}
      {application.editable ? (
        <>
          <Details application={application} onSaved={refresh} />
          <Documents application={application} onSaved={refresh} />
          <Submit application={application} onSaved={refresh} />
        </>
      ) : (
        <Summary application={application} />
      )}
    </div>
  );
}

function Details({
  application: a,
  onSaved,
}: {
  application: PartnerApplication;
  onSaved: (a: PartnerApplication) => void;
}) {
  const zones = useQuery({ queryKey: ['partner', 'zones'], queryFn: partner.zones });
  const vehicle = a.vehicles.find((v) => v.isActive) ?? a.vehicles[0];
  const [form, setForm] = useState({
    legalName: a.legalName ?? '',
    dateOfBirth: a.dateOfBirth ?? '',
    homeZoneId: a.homeZone?.id ?? '',
    pan: '',
    aadhaarLast4: '',
    contactName: a.emergencyContact?.name ?? '',
    contactRelation: a.emergencyContact?.relation ?? '',
    contactPhone: a.emergencyContact?.phone ?? '',
    vehicleType: vehicle?.type ?? '',
    registrationNumber: vehicle?.registrationNumber ?? '',
    holderName: a.bank?.holderName ?? '',
    accountNumber: '',
    ifsc: a.bank?.ifsc ?? '',
  });
  const [photo, setPhoto] = useState<File | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (form.legalName) body.legalName = form.legalName;
      if (form.dateOfBirth) body.dateOfBirth = form.dateOfBirth;
      if (form.homeZoneId) body.homeZoneId = form.homeZoneId;
      if (form.pan) body.pan = form.pan;
      if (form.aadhaarLast4) body.aadhaarLast4 = form.aadhaarLast4;
      if (form.contactName && form.contactRelation && form.contactPhone)
        body.emergencyContact = {
          name: form.contactName,
          relation: form.contactRelation,
          phone: form.contactPhone,
        };
      if (form.vehicleType)
        body.vehicle = {
          type: form.vehicleType,
          registrationNumber: form.registrationNumber || null,
        };
      if (form.holderName && form.accountNumber && form.ifsc)
        body.bank = {
          holderName: form.holderName,
          accountNumber: form.accountNumber,
          ifsc: form.ifsc,
        };
      if (photo) body.photoFileId = (await partner.upload(photo, 'PARTNER_PHOTO', photo.name)).id;
      return partner.application.update(body);
    },
    onSuccess: onSaved,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const motor = MOTORIZED.has(form.vehicleType);
  return (
    <form onSubmit={submit} className="space-y-4">
      <Section title="About you">
        <div className="grid gap-3">
          <Field
            label="Full name as on your ID"
            value={form.legalName}
            onChange={set('legalName')}
          />
          <Field
            label="Date of birth"
            type="date"
            value={form.dateOfBirth}
            onChange={set('dateOfBirth')}
          />
          <Select label="Preferred zone" value={form.homeZoneId} onChange={set('homeZoneId')}>
            <option value="">Choose a zone</option>
            {zones.data?.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}, {z.city}
              </option>
            ))}
          </Select>
          <label className="block text-sm">
            <span className="font-medium text-gray-800">Profile photo</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="mt-1 block text-sm"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            />
            {a.photoFileId && <span className="text-xs text-success-600">Photo added</span>}
          </label>
          <Field
            label="PAN"
            value={form.pan}
            onChange={set('pan')}
            placeholder={a.panMasked ?? 'ABCDE1234F'}
            autoCapitalize="characters"
          />
          <Field
            label="Last 4 digits of Aadhaar"
            inputMode="numeric"
            maxLength={4}
            value={form.aadhaarLast4}
            onChange={set('aadhaarLast4')}
            placeholder={a.aadhaarMasked ?? ''}
            hint="We never store your full Aadhaar number."
          />
        </div>
      </Section>
      <Section title="Emergency contact">
        <div className="grid gap-3">
          <Field label="Name" value={form.contactName} onChange={set('contactName')} />
          <Field label="Relation" value={form.contactRelation} onChange={set('contactRelation')} />
          <Field
            label="Phone"
            type="tel"
            value={form.contactPhone}
            onChange={set('contactPhone')}
            placeholder="+91"
          />
        </div>
      </Section>
      <Section title="Vehicle">
        <div className="grid gap-3">
          <Select label="Vehicle type" value={form.vehicleType} onChange={set('vehicleType')}>
            <option value="">Choose</option>
            {Object.entries(VEHICLE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          {motor && (
            <Field
              label="Registration number"
              value={form.registrationNumber}
              onChange={set('registrationNumber')}
              placeholder="KA01AB1234"
            />
          )}
        </div>
      </Section>
      <Section title="Bank account for payouts">
        {a.bank && (
          <p className="mb-2 text-sm text-gray-600">
            On file: {a.bank.accountMasked} · {a.bank.ifsc}
          </p>
        )}
        <div className="grid gap-3">
          <Field label="Account holder name" value={form.holderName} onChange={set('holderName')} />
          <Field
            label="Account number"
            inputMode="numeric"
            value={form.accountNumber}
            onChange={set('accountNumber')}
          />
          <Field
            label="IFSC"
            value={form.ifsc}
            onChange={set('ifsc')}
            autoCapitalize="characters"
          />
        </div>
      </Section>
      <ServerError error={save.error} />
      {save.isSuccess && <Alert tone="success">Saved</Alert>}
      <Button type="submit" loading={save.isPending}>
        Save details
      </Button>
    </form>
  );
}

function Documents({
  application: a,
  onSaved,
}: {
  application: PartnerApplication;
  onSaved: (a: PartnerApplication) => void;
}) {
  const motor = a.vehicles.some((v) => MOTORIZED.has(v.type));
  const [expiry, setExpiry] = useState('');
  const upload = useMutation({
    mutationFn: async ({ type, file }: { type: string; file: File }) => {
      const { id } = await partner.upload(file, 'PARTNER_DOCUMENT', file.name);
      return partner.application.addDocument({
        type,
        fileId: id,
        ...(type === 'DL_FRONT' && expiry ? { expiresOn: expiry } : {}),
      });
    },
    onSuccess: onSaved,
  });
  return (
    <Section title="Documents">
      <ul className="space-y-3">
        {DOCUMENTS.filter((d) => !d.motorOnly || motor).map((d) => {
          const doc = a.documents.find((x) => x.type === d.type);
          return (
            <li key={d.type} className="space-y-1 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-gray-800">{d.label}</span>
                <span className={doc ? 'text-success-600' : 'text-gray-500'}>
                  {doc ? (doc.status === 'REJECTED' ? 'Rejected' : 'Uploaded') : 'Needed'}
                </span>
              </div>
              {doc?.reviewerNote && <p className="text-danger-600">{doc.reviewerNote}</p>}
              {d.expiry && (
                <Field
                  label="Licence valid until"
                  type="date"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                />
              )}
              <input
                type="file"
                aria-label={`Upload ${d.label}`}
                accept="image/jpeg,image/png,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate({ type: d.type, file });
                }}
              />
            </li>
          );
        })}
      </ul>
      {upload.isPending && <Spinner />}
      <ServerError error={upload.error} />
    </Section>
  );
}

function Submit({
  application: a,
  onSaved,
}: {
  application: PartnerApplication;
  onSaved: (a: PartnerApplication) => void;
}) {
  const submit = useMutation({ mutationFn: partner.application.submit, onSuccess: onSaved });
  return (
    <Section title="Submit">
      {a.missing.length > 0 ? (
        <>
          <p className="text-sm text-gray-700">Still needed:</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-gray-800">
            {a.missing.map((m) => (
              <li key={m.path}>{m.message}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-gray-700">Everything is in. Submit for review.</p>
      )}
      <ServerError error={submit.error} />
      <Button
        className="mt-3"
        disabled={a.missing.length > 0}
        loading={submit.isPending}
        onClick={() => submit.mutate()}
      >
        Submit application
      </Button>
    </Section>
  );
}

function Summary({ application: a }: { application: PartnerApplication }) {
  return (
    <Section title="What you sent">
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-gray-500">Name</dt>
        <dd>{a.legalName}</dd>
        <dt className="text-gray-500">Zone</dt>
        <dd>{a.homeZone?.name ?? '—'}</dd>
        <dt className="text-gray-500">Vehicle</dt>
        <dd>{a.vehicles.map((v) => VEHICLE_LABEL[v.type]).join(', ') || '—'}</dd>
        <dt className="text-gray-500">Bank</dt>
        <dd>{a.bank?.accountMasked ?? '—'}</dd>
        <dt className="text-gray-500">Documents</dt>
        <dd>{a.documents.length}</dd>
      </dl>
    </Section>
  );
}
