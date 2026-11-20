import { useState, type FormEvent } from 'react';
import type { Address, LatLng } from '@fos/api-client';
import { Button } from '@fos/ui';
import { customer } from '../lib/customer';
import { Field, Select, ServerError } from './ui';

/** Minimal "add address" form for checkout; full management comes with the account screens. */
export function AddressForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: (LatLng & { area?: string }) | null;
  onSaved: (address: Address) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    label: 'HOME' as Address['label'],
    line1: '',
    area: initial?.area ?? '',
    city: '',
    state: '',
    pincode: '',
    lat: initial ? String(initial.lat) : '',
    lng: initial ? String(initial.lng) : '',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const lat = Number(form.lat);
    const lng = Number(form.lng);
    if (!form.lat || !form.lng || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError(new Error('Set the map pin: enter a latitude and longitude.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await customer.addresses.create({
        label: form.label,
        line1: form.line1.trim(),
        area: form.area.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        pincode: form.pincode.trim(),
        location: { lat, lng },
      });
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={submit} noValidate aria-label="New address">
      <Select label="Save as" value={form.label} onChange={set('label')}>
        <option value="HOME">Home</option>
        <option value="WORK">Work</option>
        <option value="OTHER">Other</option>
      </Select>
      <Field label="House / flat, building" value={form.line1} onChange={set('line1')} required />
      <Field label="Area" value={form.area} onChange={set('area')} required />
      <div className="grid grid-cols-2 gap-3">
        <Field label="City" value={form.city} onChange={set('city')} required />
        <Field label="State" value={form.state} onChange={set('state')} required />
      </div>
      <Field
        label="PIN code"
        inputMode="numeric"
        maxLength={6}
        value={form.pincode}
        onChange={set('pincode')}
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Latitude" inputMode="decimal" value={form.lat} onChange={set('lat')} />
        <Field label="Longitude" inputMode="decimal" value={form.lng} onChange={set('lng')} />
      </div>
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
