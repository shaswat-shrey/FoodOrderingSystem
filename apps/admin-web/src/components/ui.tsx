import {
  useId,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link } from 'react-router';
import { isApiClientError, type AdminPagination } from '@fos/api-client';
import { Alert, Button, cn, EmptyState, ErrorState, Spinner, type ButtonProps } from '@fos/ui';

const inputClass =
  'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-200';

/** A labelled control; the hint sits outside the label so the accessible name is just `label`. */
function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (ids: { id: string; hintId?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="block text-sm">
      <label htmlFor={id} className="font-medium text-gray-800">
        {label}
      </label>
      {children({ id, hintId })}
      {hint && (
        <span id={hintId} className="mt-1 block text-xs text-gray-500">
          {hint}
        </span>
      )}
    </div>
  );
}

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <Labelled label={label} hint={hint}>
      {({ id, hintId }) => (
        <input
          id={id}
          aria-describedby={hintId}
          {...props}
          className={cn(inputClass, 'h-10', props.className)}
        />
      )}
    </Labelled>
  );
}

export function TextArea({
  label,
  hint,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  return (
    <Labelled label={label} hint={hint}>
      {({ id, hintId }) => (
        <textarea
          id={id}
          aria-describedby={hintId}
          rows={3}
          {...props}
          className={cn(inputClass, 'py-2', props.className)}
        />
      )}
    </Labelled>
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
      <select {...props} className={cn(inputClass, 'h-10')}>
        {children}
      </select>
    </label>
  );
}

/** `<option>`s for an enum, with an "Any" choice first when `any` is given. */
export function Options({ values, any }: { values: readonly string[]; any?: string }) {
  return (
    <>
      {any !== undefined && <option value="">{any}</option>}
      {values.map((v) => (
        <option key={v} value={v}>
          {v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' ')}
        </option>
      ))}
    </>
  );
}

export function Section({
  title,
  children,
  aside,
  className,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('rounded-xl border border-gray-200 bg-white p-4 shadow-sm', className)}
      aria-label={title}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <div className="mb-4 space-y-1">
      {back && (
        <Link to={back.to} className="text-sm text-brand-700 underline-offset-2 hover:underline">
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl">{title}</h1>
          {subtitle && <div className="mt-0.5 text-sm text-gray-600">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-900">{value}</div>
      {hint && <div className="text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

/** Label/value pairs. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-gray-100 py-1">
          <dt className="text-gray-500">{k}</dt>
          <dd className="text-right font-medium text-gray-900">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

const GOOD = new Set([
  'ACTIVE',
  'APPROVED',
  'DELIVERED',
  'SUCCEEDED',
  'CAPTURED',
  'COLLECTED',
  'PAID',
  'RESOLVED',
  'VERIFIED',
  'IN_EFFECT',
  'PROCESSED',
  'ONLINE_IDLE',
]);
const BAD = new Set([
  'SUSPENDED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
  'CRITICAL',
  'URGENT',
  'DEACTIVATED',
  'PARTIALLY_FAILED',
  'EXPIRED',
  'HIGH',
]);
const WAIT = new Set([
  'PENDING',
  'SUBMITTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'REQUESTED',
  'OPEN',
  'SEARCHING',
  'WARNING',
  'DRAFT',
  'SCHEDULED',
  'PROCESSING',
  'ACKNOWLEDGED',
]);

export function Badge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  if (!value) return <span className="text-gray-400">—</span>;
  const tone = GOOD.has(value)
    ? 'bg-green-50 text-green-800 ring-green-200'
    : BAD.has(value)
      ? 'bg-red-50 text-red-800 ring-red-200'
      : WAIT.has(value)
        ? 'bg-amber-50 text-amber-800 ring-amber-200'
        : 'bg-gray-100 text-gray-700 ring-gray-200';
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        tone,
        className,
      )}
    >
      {value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')}
    </span>
  );
}

/** A scrollable data table; `head` are column titles. */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className="whitespace-nowrap px-3 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top">
          {children}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({
  pagination,
  onPage,
}: {
  pagination: AdminPagination;
  onPage: (page: number) => void;
}) {
  const { page, pageSize, total, hasMore } = pagination;
  if (total <= pageSize && page === 1) return null;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  return (
    <nav aria-label="Pagination" className="mt-3 flex items-center justify-between text-sm">
      <span className="text-gray-600">
        {from}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" variant="secondary" disabled={!hasMore} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
}

export function Forbidden() {
  return (
    <EmptyState
      title="You don't have access"
      description="Your admin role doesn't include this area. Ask a super admin if you need it."
    />
  );
}

/** Server error with its field details (validation, limits, checklist items). */
export function ServerError({ error }: { error: unknown }) {
  if (!error) return null;
  if (!isApiClientError(error))
    return (
      <Alert tone="error">{error instanceof Error ? error.message : 'Something went wrong.'}</Alert>
    );
  return (
    <Alert tone="error" title={error.message}>
      {error.details.length > 0 && error.details.some((d) => d.message !== error.message) && (
        <ul className="mt-1 list-disc pl-5">
          {error.details.map((d, i) => (
            <li key={i}>
              {d.path ? `${d.path}: ` : ''}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

/** Loading, 403, 404 and error states for a query; renders `children` with its data. */
export function Loader<T>({
  query,
  children,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending)
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-gray-600">
        <Spinner label="Loading" /> Loading…
      </p>
    );
  if (query.isError) {
    const e = query.error;
    if (isApiClientError(e) && e.status === 403) return <Forbidden />;
    if (isApiClientError(e) && e.status === 404)
      return <EmptyState title="Not found" description={e.message} />;
    return (
      <ErrorState
        title="Couldn't load this"
        description={e instanceof Error ? e.message : undefined}
        action={
          <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  return <>{children(query.data)}</>;
}

export const REASON_MIN = 5;
export const REASON_MAX = 500;
export const validReason = (r: string) =>
  r.trim().length >= REASON_MIN && r.trim().length <= REASON_MAX;

/**
 * A button that opens a confirmation dialog. ★ actions (BR-ADMIN-002) require a
 * 5–500 character reason, kept in the audit log, before anything is sent.
 * Extra inputs go in `children`; `ready` gates submission on them. On success
 * every cached query is refetched and the dialog closes.
 */
export function ActionDialog<T>({
  label,
  title,
  description,
  variant = 'secondary',
  size = 'sm',
  confirmLabel,
  reason = 'required',
  ready = true,
  disabled,
  children,
  onConfirm,
  onDone,
}: {
  label: string;
  title?: string;
  description?: ReactNode;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  confirmLabel?: string;
  reason?: 'required' | 'optional' | 'none';
  ready?: boolean;
  disabled?: boolean;
  children?: ReactNode;
  onConfirm: (reason: string) => Promise<T>;
  onDone?: (result: T) => void;
}) {
  const qc = useQueryClient();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reasonOk =
    reason === 'none' || (reason === 'optional' && text.trim() === '') || validReason(text);

  const close = () => {
    setOpen(false);
    setText('');
    setError(null);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reasonOk || !ready || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await onConfirm(text.trim());
      close();
      onDone?.(result);
      void qc.invalidateQueries();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button variant={variant} size={size} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
            onKeyDown={(e) => e.key === 'Escape' && close()}
          >
            <form onSubmit={(e) => void submit(e)} className="space-y-3">
              <h2 id={titleId} className="text-lg font-semibold text-gray-900">
                {title ?? label}
              </h2>
              {description && <div className="text-sm text-gray-600">{description}</div>}
              {children}
              {reason !== 'none' && (
                <TextArea
                  label={reason === 'required' ? 'Reason' : 'Reason (optional)'}
                  hint={`${REASON_MIN}–${REASON_MAX} characters; kept in the audit log.`}
                  value={text}
                  maxLength={REASON_MAX}
                  autoFocus={!children}
                  onChange={(e) => setText(e.target.value)}
                />
              )}
              <ServerError error={error} />
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={variant === 'danger' ? 'danger' : 'primary'}
                  disabled={!reasonOk || !ready}
                  loading={pending}
                >
                  {confirmLabel ?? 'Confirm'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

/** Simple tab strip driven by local state. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-gray-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          type="button"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
            value === t.key
              ? 'border-brand-700 text-brand-800'
              : 'border-transparent text-gray-600 hover:text-gray-900',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Filter bar wrapper. */
export function Filters({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-4 text-sm text-gray-500">{children}</p>;
}

export function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-gray-400">—</span>;
  return (
    <pre className="max-w-md overflow-x-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-1 text-xs">
      {JSON.stringify(value, null, 1)}
    </pre>
  );
}
