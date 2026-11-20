import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
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
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-base font-semibold text-gray-900">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Server error with its field details (validation, checklist items). */
export function ServerError({ error }: { error: unknown }) {
  if (!error) return null;
  if (!isApiClientError(error)) return <Alert tone="error">Something went wrong.</Alert>;
  return (
    <Alert tone="error" title={error.message}>
      {error.details.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {error.details.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}
