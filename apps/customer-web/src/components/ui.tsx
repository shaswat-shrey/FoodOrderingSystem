import {
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { isApiClientError } from '@fos/api-client';
import { Alert, Button, cn } from '@fos/ui';
import { rupees } from '../lib/format';

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
        className="mt-1 block h-11 w-full rounded-md border border-gray-300 px-3 text-base focus:border-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-200"
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
        className="mt-1 block h-11 w-full rounded-md border border-gray-300 bg-white px-3 text-base focus:border-brand-700 focus:outline-none"
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
  className,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-gray-200 bg-white p-4 shadow-sm', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Server error with its field details. */
export function ServerError({ error }: { error: unknown }) {
  if (!error) return null;
  if (!isApiClientError(error))
    return (
      <Alert tone="error">{error instanceof Error ? error.message : 'Something went wrong.'}</Alert>
    );
  const extra = error.details.filter((d) => d.message && d.message !== error.message);
  return (
    <Alert tone="error" title={error.message}>
      {extra.length > 1 && (
        <ul className="mt-1 list-disc pl-5">
          {extra.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

/** Modal dialog; a bottom sheet on phones (UI-DS-004 Dialog / Sheet). */
export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[90dvh] w-full flex-col rounded-t-2xl bg-white shadow-xl focus:outline-none sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
          <h2 id={titleId} className="text-lg font-semibold text-gray-900">
            {title}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="border-t border-gray-100 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** − n + with 44 px targets (UI-DS-004 QuantityStepper). */
export function QuantityStepper({
  value,
  onChange,
  label,
  min = 0,
  max = 20,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  label: string;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <div
      className="inline-flex items-center rounded-lg border border-brand-700 text-brand-700"
      role="group"
      aria-label={`Quantity of ${label}`}
    >
      <button
        type="button"
        className="h-11 w-11 text-lg font-semibold disabled:opacity-50"
        onClick={() => onChange(value - 1)}
        disabled={disabled || value <= min}
        aria-label={value - 1 === 0 ? `Remove ${label}` : `Decrease ${label}`}
      >
        −
      </button>
      <span className="w-6 text-center font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="h-11 w-11 text-lg font-semibold disabled:opacity-50"
        onClick={() => onChange(value + 1)}
        disabled={disabled || value >= max}
        aria-label={`Increase ${label}`}
      >
        +
      </button>
    </div>
  );
}

export function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  tone?: 'success';
}) {
  return (
    <div
      className={cn(
        'flex justify-between gap-4 py-0.5',
        strong && 'border-t border-gray-200 pt-2 text-base font-semibold text-gray-900',
        tone === 'success' && 'text-success-600',
      )}
    >
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** UI-DS-004 PriceBreakdown, straight from the server's quote. */
export function PriceBreakdown({
  quote,
}: {
  quote: {
    itemsSubtotal: number;
    itemDiscountTotal: number;
    discounts: { id: string; label: string; amount: number }[];
    packagingFee: number;
    deliveryFee: number;
    deliveryFeeWaived: number;
    deliveryFeeKnown: boolean;
    surgeFee: number;
    smallOrderFee: number;
    platformFee: number;
    taxTotal: number;
    tip: number;
    walletApplied: number;
    total: number;
    payable: number;
  };
}) {
  return (
    <dl className="space-y-0.5 text-sm text-gray-700" aria-label="Price breakdown">
      <Row label="Item total" value={rupees(quote.itemsSubtotal)} />
      {quote.itemDiscountTotal > 0 && (
        <Row label="Item discounts" value={`−${rupees(quote.itemDiscountTotal)}`} tone="success" />
      )}
      {quote.discounts
        .filter((d) => d.amount > 0)
        .map((d) => (
          <Row key={d.id} label={d.label} value={`−${rupees(d.amount)}`} tone="success" />
        ))}
      {quote.packagingFee > 0 && <Row label="Packaging" value={rupees(quote.packagingFee)} />}
      <Row
        label="Delivery fee"
        value={
          !quote.deliveryFeeKnown
            ? 'Set a location'
            : quote.deliveryFeeWaived > 0 && quote.deliveryFee === 0
              ? 'Free'
              : rupees(quote.deliveryFee)
        }
      />
      {quote.surgeFee > 0 && <Row label="Busy-time fee" value={rupees(quote.surgeFee)} />}
      {quote.smallOrderFee > 0 && (
        <Row label="Small order fee" value={rupees(quote.smallOrderFee)} />
      )}
      {quote.platformFee > 0 && <Row label="Platform fee" value={rupees(quote.platformFee)} />}
      <Row label="Taxes" value={rupees(quote.taxTotal)} />
      {quote.tip > 0 && <Row label="Tip" value={rupees(quote.tip)} />}
      {quote.walletApplied > 0 && (
        <>
          <Row label="Total" value={rupees(quote.total)} />
          <Row label="Wallet" value={`−${rupees(quote.walletApplied)}`} tone="success" />
        </>
      )}
      <Row label="To pay" value={rupees(quote.payable)} strong />
    </dl>
  );
}
