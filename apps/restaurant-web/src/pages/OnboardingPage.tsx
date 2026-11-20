import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Application } from '@fos/api-client';
import { Alert, Button, Spinner } from '@fos/ui';
import { Field, Section, Select, ServerError } from '../components/fields';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

const STATUS_TEXT: Record<string, string> = {
  DRAFT: 'Draft — finish the steps below and submit.',
  SUBMITTED: 'Submitted — our team will review it shortly.',
  UNDER_REVIEW: 'Under review.',
  CHANGES_REQUESTED: 'Changes requested — see the comments, update and resubmit.',
  REJECTED: 'Not approved.',
};
const DOCS = [
  ['FSSAI', 'FSSAI licence'],
  ['PAN', 'PAN card'],
  ['GST', 'GST certificate (if registered)'],
  ['BANK_PROOF', 'Cancelled cheque or bank statement'],
] as const;
const form = (e: FormEvent<HTMLFormElement>) =>
  Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;

/** FR-REST-001…005: the restaurant application, section by section. */
export function OnboardingPage() {
  const { me, refresh } = useWorkspace();
  const current = me?.applications[0];
  const start = useMutation({
    mutationFn: (b: { brandName: string; legalName: string; entityType: string }) =>
      merchant.applications.start(b),
    onSuccess: () => refresh(),
  });
  if (!current)
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-2xl font-bold">List your restaurant</h1>
        <p className="text-gray-700">
          Tell us about your business. You can save and come back any time.
        </p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const v = form(e);
            start.mutate({
              brandName: v.brandName!,
              legalName: v.legalName!,
              entityType: v.entityType!,
            });
          }}
        >
          <Field
            label="Restaurant name (as customers see it)"
            name="brandName"
            required
            minLength={2}
          />
          <Field label="Legal business name" name="legalName" required minLength={2} />
          <Select label="Business type" name="entityType" defaultValue="PROPRIETORSHIP">
            <option value="PROPRIETORSHIP">Proprietorship</option>
            <option value="PARTNERSHIP">Partnership</option>
            <option value="LLP">LLP</option>
            <option value="PRIVATE_LIMITED">Private limited</option>
            <option value="PUBLIC_LIMITED">Public limited</option>
            <option value="OTHER">Other</option>
          </Select>
          <ServerError error={start.error} />
          <Button type="submit" loading={start.isPending}>
            Start application
          </Button>
        </form>
      </div>
    );
  return <ApplicationEditor id={current.id} />;
}

function ApplicationEditor({ id }: { id: string }) {
  const qc = useQueryClient();
  const app = useQuery({
    queryKey: ['application', id],
    queryFn: () => merchant.applications.get(id),
  });
  const cuisines = useQuery({ queryKey: ['cuisines'], queryFn: merchant.cuisines });
  const set = (a: Application) => qc.setQueryData(['application', id], a);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => merchant.applications.update(id, body),
    onSuccess: set,
  });
  const upload = useMutation({
    mutationFn: async ({ file, kind }: { file: File; kind: string }) => {
      if (kind === 'LOGO') {
        const f = await merchant.upload(file, 'RESTAURANT_LOGO', file.name);
        return merchant.applications.update(id, { logoFileId: f.id });
      }
      const f = await merchant.upload(file, 'RESTAURANT_DOCUMENT', file.name);
      await merchant.applications.addDocument(id, { type: kind, fileId: f.id });
      return merchant.applications.get(id);
    },
    onSuccess: set,
  });
  const [noGst, setNoGst] = useState(false);
  const submit = useMutation({
    mutationFn: () => merchant.applications.submit(id, noGst),
    onSuccess: set,
  });
  if (!app.data) return <Spinner />;
  const a = app.data;
  const ro = !a.editable;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold">{a.brandName}</h1>
      <Alert
        tone={
          a.status === 'REJECTED' ? 'error' : a.status === 'CHANGES_REQUESTED' ? 'warning' : 'info'
        }
      >
        {STATUS_TEXT[a.status] ?? a.status} {a.rejectedReason}
      </Alert>
      {a.review && Object.keys(a.review.comments).length > 0 && (
        <Alert tone="warning" title="Reviewer comments">
          <ul className="list-disc pl-5">
            {Object.entries(a.review.comments).map(([k, v]) => (
              <li key={k}>
                <strong>{k}</strong>: {v}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <ServerError error={save.error ?? upload.error} />

      <Section title="1. Business details">
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = form(e);
            save.mutate({
              ...(v.pan ? { pan: v.pan } : {}),
              ...(v.gstin ? { gstin: v.gstin } : {}),
              fssaiNumber: v.fssaiNumber,
              fssaiExpiresOn: v.fssaiExpiresOn,
              description: v.description || null,
              cuisineIds: v.cuisine ? [v.cuisine] : undefined,
            });
          }}
        >
          <Field
            label={`PAN ${a.panMasked ? `(saved: ${a.panMasked})` : ''}`}
            name="pan"
            placeholder="ABCDE1234F"
            disabled={ro}
          />
          <Field label="GSTIN (optional)" name="gstin" defaultValue={a.gstin ?? ''} disabled={ro} />
          <Field
            label="FSSAI licence number"
            name="fssaiNumber"
            defaultValue={a.fssaiNumber ?? ''}
            required
            disabled={ro}
          />
          <Field
            label="FSSAI valid until"
            name="fssaiExpiresOn"
            type="date"
            defaultValue={a.fssaiExpiresOn ?? ''}
            required
            disabled={ro}
          />
          <Select
            label="Main cuisine"
            name="cuisine"
            defaultValue={a.cuisines[0]?.id ?? ''}
            disabled={ro}
          >
            <option value="">Choose…</option>
            {cuisines.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Field
            label="Short description"
            name="description"
            defaultValue={a.description ?? ''}
            disabled={ro}
          />
          {!ro && (
            <div className="md:col-span-2">
              <Button type="submit" loading={save.isPending}>
                Save
              </Button>
            </div>
          )}
        </form>
      </Section>

      <Section title="2. Outlet">
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = form(e);
            save.mutate({
              branch: {
                name: v.name,
                line1: v.line1,
                area: v.area,
                city: v.city,
                state: v.state,
                pincode: v.pincode,
                location: { lat: Number(v.lat), lng: Number(v.lng) },
                deliveryRadiusM: Math.round(Number(v.radiusKm) * 1000),
                defaultPrepMinutes: Number(v.prep),
                hours: a.branch?.hours.length
                  ? a.branch.hours
                  : [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
                      weekday,
                      opensAt: '11:00',
                      closesAt: '23:00',
                    })),
              },
            });
          }}
        >
          <Field
            label="Outlet name"
            name="name"
            defaultValue={a.branch?.name ?? ''}
            required
            disabled={ro}
          />
          <Field
            label="Address line"
            name="line1"
            defaultValue={a.branch?.line1 ?? ''}
            required
            disabled={ro}
          />
          <Field
            label="Area"
            name="area"
            defaultValue={a.branch?.area ?? ''}
            required
            disabled={ro}
          />
          <Field
            label="City"
            name="city"
            defaultValue={a.branch?.city ?? 'Bengaluru'}
            required
            disabled={ro}
          />
          <Field
            label="State"
            name="state"
            defaultValue={a.branch?.state ?? 'Karnataka'}
            required
            disabled={ro}
          />
          <Field
            label="PIN code"
            name="pincode"
            defaultValue={a.branch?.pincode ?? ''}
            required
            disabled={ro}
          />
          <Field
            label="Latitude"
            name="lat"
            type="number"
            step="any"
            defaultValue={a.branch?.location?.lat ?? ''}
            required
            disabled={ro}
            hint="Map pin picker arrives with the map screens (Phase 12)."
          />
          <Field
            label="Longitude"
            name="lng"
            type="number"
            step="any"
            defaultValue={a.branch?.location?.lng ?? ''}
            required
            disabled={ro}
          />
          <Field
            label="Delivery radius (km)"
            name="radiusKm"
            type="number"
            step="0.5"
            min={0.5}
            defaultValue={(a.branch?.deliveryRadiusM ?? 4000) / 1000}
            required
            disabled={ro}
          />
          <Field
            label="Average prep time (min)"
            name="prep"
            type="number"
            min={5}
            max={90}
            defaultValue={a.branch?.defaultPrepMinutes ?? 20}
            required
            disabled={ro}
          />
          <p className="text-sm text-gray-600 md:col-span-2">
            Opening hours default to 11:00–23:00 daily; change them any time after approval.
          </p>
          {!ro && (
            <div className="md:col-span-2">
              <Button type="submit" loading={save.isPending}>
                Save outlet
              </Button>
            </div>
          )}
        </form>
      </Section>

      <Section title="3. Bank account">
        {a.bank && (
          <p className="mb-2 text-sm">
            Saved: {a.bank.holderName} · {a.bank.accountMasked} · {a.bank.ifsc}
          </p>
        )}
        {!ro && (
          <form
            className="grid gap-3 md:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              const v = form(e);
              save.mutate({
                bank: { holderName: v.holderName, accountNumber: v.accountNumber, ifsc: v.ifsc },
              });
            }}
          >
            <Field label="Account holder" name="holderName" required />
            <Field label="Account number" name="accountNumber" inputMode="numeric" required />
            <Field label="IFSC" name="ifsc" required />
            <div className="md:col-span-3">
              <Button type="submit" loading={save.isPending}>
                Save bank account
              </Button>
            </div>
          </form>
        )}
      </Section>

      <Section title="4. Documents and logo">
        <ul className="space-y-2 text-sm">
          {[['LOGO', 'Logo'] as const, ...DOCS].map(([kind, label]) => {
            const have =
              kind === 'LOGO' ? Boolean(a.logo) : a.documents.some((d) => d.type === kind);
            return (
              <li key={kind} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {have ? '✓' : '○'} {label}
                </span>
                {!ro && (
                  <input
                    aria-label={`Upload ${label}`}
                    type="file"
                    accept={
                      kind === 'LOGO'
                        ? 'image/jpeg,image/png,image/webp'
                        : 'application/pdf,image/jpeg,image/png'
                    }
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload.mutate({ file: f, kind });
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {upload.isPending && <Spinner />}
      </Section>

      {a.editable && (
        <Section title="5. Submit">
          {a.missing.length > 0 && (
            <Alert tone="warning" title="Still needed">
              <ul className="list-disc pl-5">
                {a.missing.map((m) => (
                  <li key={m.path}>{m.message}</li>
                ))}
              </ul>
            </Alert>
          )}
          {!a.gstin && (
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={noGst} onChange={(e) => setNoGst(e.target.checked)} />{' '}
              I declare the business is not registered for GST.
            </label>
          )}
          <ServerError error={submit.error} />
          <Button className="mt-3" loading={submit.isPending} onClick={() => submit.mutate()}>
            Submit for review
          </Button>
        </Section>
      )}
    </div>
  );
}
