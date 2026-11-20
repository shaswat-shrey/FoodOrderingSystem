import { useId, useState, type ReactNode } from 'react';
import { Button, cn } from '@fos/ui';
import { customer } from '../lib/customer';
import type { AccountUploadPurpose } from '@fos/api-client';
import { Dialog, ServerError } from './ui';

/** 1–5 stars as a radio group (keyboard and screen-reader friendly). */
export function StarRating({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: number;
  onChange: (stars: number) => void;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="text-sm font-medium text-gray-800">{legend}</legend>
      <div className="mt-1 flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="cursor-pointer">
            <input
              type="radio"
              name={name}
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              className="peer sr-only"
              aria-label={n === 1 ? '1 star' : `${n} stars`}
            />
            <span
              aria-hidden="true"
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-lg text-2xl peer-focus-visible:ring-2 peer-focus-visible:ring-brand-200',
                n <= value ? 'text-amber-500' : 'text-gray-300',
              )}
            >
              ★
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export const Stars = ({ rating }: { rating: number }) => (
  <span className="text-amber-500" aria-label={`${rating} out of 5 stars`}>
    {'★'.repeat(rating)}
    <span className="text-gray-300">{'★'.repeat(Math.max(0, 5 - rating))}</span>
  </span>
);

/** Multi-select chips backed by checkboxes. */
export function TagPicker<T extends string>({
  legend,
  options,
  value,
  onChange,
  max,
}: {
  legend: string;
  options: Record<T, string>;
  value: T[];
  onChange: (next: T[]) => void;
  max?: number;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-gray-800">{legend}</legend>
      <div className="mt-1 flex flex-wrap gap-2">
        {(Object.keys(options) as T[]).map((tag) => {
          const on = value.includes(tag);
          return (
            <label
              key={tag}
              className={cn(
                'flex min-h-11 cursor-pointer items-center rounded-full border px-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-200',
                on
                  ? 'border-brand-700 bg-brand-50 text-brand-800'
                  : 'border-gray-300 text-gray-700',
              )}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={on}
                disabled={!on && max !== undefined && value.length >= max}
                onChange={() => onChange(on ? value.filter((t) => t !== tag) : [...value, tag])}
              />
              {options[tag]}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Uploads photos as they are picked; hands back the file ids (FR-FILE-001). */
export function PhotoPicker({
  label,
  purpose,
  max = 3,
  value,
  onChange,
}: {
  label: string;
  purpose: AccountUploadPurpose;
  max?: number;
  value: { id: string; name: string }[];
  onChange: (next: { id: string; name: string }[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const room = max - value.length;
    const chosen = Array.from(files).slice(0, room);
    setBusy(true);
    setError(null);
    const added: { id: string; name: string }[] = [];
    try {
      for (const f of chosen) {
        const uploaded = await customer.files.upload(f, purpose, f.name);
        added.push({ id: uploaded.id, name: f.name });
      }
      if (files.length > room) setError(new Error(`You can add up to ${max} photos.`));
    } catch (e) {
      setError(e);
    } finally {
      onChange([...value, ...added]);
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <label className="block">
        <span className="font-medium text-gray-800">{label}</span>
        <span className="block text-xs text-gray-500">JPEG, PNG or WebP, up to {max} photos.</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={busy || value.length >= max}
          onChange={(e) => {
            void pick(e.target.files);
            e.target.value = '';
          }}
          className="mt-1 block w-full text-sm file:mr-3 file:h-11 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3"
        />
      </label>
      {busy && <p className="text-xs text-gray-600">Uploading…</p>}
      {value.length > 0 && (
        <ul className="space-y-1" aria-label="Attached photos">
          {value.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{p.name}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange(value.filter((x) => x.id !== p.id))}
                aria-label={`Remove ${p.name}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ServerError error={error} />
    </div>
  );
}

/** "Load more" for cursor-paginated lists. */
export function LoadMore({
  hasMore,
  loading,
  onClick,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center pt-2">
      <Button variant="secondary" loading={loading} onClick={onClick}>
        Load more
      </Button>
    </div>
  );
}

/** "Are you sure?" for destructive actions. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-2 text-sm text-gray-700">
        {children}
        <ServerError error={error} />
      </div>
    </Dialog>
  );
}

export function PageTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <h1 className="text-2xl font-bold text-gray-900">{children}</h1>
      {aside}
    </div>
  );
}
