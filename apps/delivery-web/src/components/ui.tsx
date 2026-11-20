import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { isApiClientError } from '@fos/api-client';
import { Alert } from '@fos/ui';

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-gray-800">{label}</span>
      <input
        {...props}
        className="mt-1 block h-11 w-full rounded-md border border-gray-300 px-3 text-sm focus:border-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export function Select({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-gray-800">{label}</span>
      <select
        {...props}
        className="mt-1 block h-11 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-brand-700 focus:outline-none"
      >
        {children}
      </select>
    </label>
  );
}

export function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-900">{value}</div>
    </div>
  );
}

/** Server error with its field details (validation, checklist items, blockers). */
export function ServerError({ error }: { error: unknown }) {
  if (!error) return null;
  if (!isApiClientError(error))
    return (
      <Alert tone="error">{error instanceof Error ? error.message : 'Something went wrong.'}</Alert>
    );
  return (
    <Alert tone="error" title={error.message}>
      {error.details.length > 1 && (
        <ul className="mt-1 list-disc pl-5">
          {error.details.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}
