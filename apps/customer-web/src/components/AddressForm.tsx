import { useState, type FormEvent } from 'react';
import type { Address, LatLng } from '@fos/api-client';
import { Button } from '@fos/ui';
import { customer } from '../lib/customer';
import { currentPosition } from '../lib/location';
import { Field, Select, ServerError } from './ui';

type Form = {
  label: Address['label'];
  line1: string;
  landmark: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
  lat: string;
  lng: string;
  instructions: string;
  isDefault: boolean;
};
type Errors = Partial<Record<keyof Form, string>>;

/** Mirrors the API's address rules (validation/customers.ts) so mistakes show before saving. */
function validate(f: Form): Errors {
  const e: Errors = {};
  if (!f.line1.trim()) e.line1 = 'Enter house / flat number';
  if (f.area.trim().length < 2) e.area = 'Enter the area';
  if (f.city.trim().length < 2) e.city = 'Enter the city';
  if (f.state.trim().length < 2) e.state = 'Enter the state';
  if (!/^[1-9]\d{5}$/.test(f.pincode.trim())) e.pincode = 'Enter a valid 6-digit PIN code';
  const lat = Number(f.lat);
  const lng = Number(f.lng);
  if (!f.lat.trim() || !Number.isFinite(lat) || lat < -90 || lat > 90)
    e.lat = 'Enter a latitude between -90 and 90';
  if (!f.lng.trim() || !Number.isFinite(lng) || lng < -180 || lng > 180)
    e.lng = 'Enter a longitude between -180 and 180';
  return e;
}

/**
 * Add or edit a saved address (FR-ADDR-001/003). The map pin is entered as
 * coordinates (or taken from the browser), as on the location page.
 */
export function AddressForm({
  initial,
  address,
  onSaved,
  onCancel,
}: {
  initial?: (LatLng & { area?: string }) | null;
  /** Editing an existing address. */
  address?: Address;
  onSaved: (address: Address) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Form>(() =>
    address
      ? {
          label: address.label,
          line1: address.line1,
          landmark: address.landmark ?? '',
          area: address.area,
          city: address.city,
          state: address.state,
          pincode: address.pincode,
          lat: String(address.location.lat),
          lng: String(address.location.lng),
          instructions: address.instructions ?? '',
          isDefault: address.isDefault,
        }
      : {
          label: 'HOME',
          line1: '',
          landmark: '',
          area: initial?.area ?? '',
          city: '',
          state: '',
          pincode: '',
          lat: initial ? String(initial.lat) : '',
          lng: initial ? String(initial.lng) : '',
          instructions: '',
          isDefault: false,
        },
  );
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  async function locate() {
    setLocating(true);
    setError(null);
    try {
      const p = await currentPosition();
      setForm((f) => ({ ...f, lat: p.lat.toFixed(6), lng: p.lng.toFixed(6) }));
    } catch (e) {
      setError(e);
    } finally {
      setLocating(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setError(new Error('Check the highlighted fields.'));
      return;
    }
    setBusy(true);
    setError(null);
    const fields = {
      label: form.label,
      line1: form.line1.trim(),
      area: form.area.trim(),
      city: form.city.trim(),
      state: form.state.trim(),
      pincode: form.pincode.trim(),
      location: { lat: Number(form.lat), lng: Number(form.lng) },
      ...(form.landmark.trim() ? { landmark: form.landmark.trim() } : {}),
      ...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {}),
    };
    try {
      const saved = address
        ? await customer.addresses.update(address.id, fields)
        : await customer.addresses.create({
            ...fields,
            ...(form.isDefault ? { isDefault: true } : {}),
          });
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={submit}
      noValidate
      aria-label={address ? 'Edit address' : 'New address'}
    >
      <Select label="Save as" value={form.label} onChange={set('label')}>
        <option value="HOME">Home</option>
        <option value="WORK">Work</option>
        <option value="OTHER">Other</option>
      </Select>
      <Field
        label="House / flat, building"
        value={form.line1}
        onChange={set('line1')}
        error={errors.line1}
        required
      />
      <Field label="Landmark (optional)" value={form.landmark} onChange={set('landmark')} />
      <Field label="Area" value={form.area} onChange={set('area')} error={errors.area} required />
      <div className="grid grid-cols-2 gap-3">
        <Field label="City" value={form.city} onChange={set('city')} error={errors.city} required />
        <Field
          label="State"
          value={form.state}
          onChange={set('state')}
          error={errors.state}
          required
        />
      </div>
      <Field
        label="PIN code"
        inputMode="numeric"
        maxLength={6}
        value={form.pincode}
        onChange={set('pincode')}
        error={errors.pincode}
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Latitude"
          inputMode="decimal"
          value={form.lat}
          onChange={set('lat')}
          error={errors.lat}
        />
        <Field
          label="Longitude"
          inputMode="decimal"
          value={form.lng}
          onChange={set('lng')}
          error={errors.lng}
        />
      </div>
      <Button variant="ghost" size="sm" loading={locating} onClick={() => void locate()}>
        📍 Use my current location
      </Button>
      <Field
        label="Delivery instructions (optional)"
        maxLength={200}
        value={form.instructions}
        onChange={set('instructions')}
      />
      {!address && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={form.isDefault}
            onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
          />
          Make this my default address
        </label>
      )}
      <ServerError error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          Save address
        </Button>
      </div>
    </form>
  );
}
