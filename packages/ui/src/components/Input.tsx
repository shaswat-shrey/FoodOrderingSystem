import {
  forwardRef,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from 'react';
import { cn } from '../cn';

const fieldBase =
  'block h-11 w-full rounded-lg border bg-white px-3 text-base text-gray-900 placeholder:text-gray-400 disabled:bg-gray-100 disabled:text-gray-500';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the field invalid (red border, aria-invalid). */
  invalid?: boolean;
  /** Fixed text shown before the value, e.g. a country code. */
  prefix?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid = false, prefix, ...props }, ref) => {
    const input = (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          fieldBase,
          invalid ? 'border-danger-600' : 'border-gray-300',
          prefix && 'rounded-l-none',
          className,
        )}
        {...props}
      />
    );
    if (!prefix) return input;
    return (
      <div className="flex">
        <span
          aria-hidden="true"
          className="inline-flex h-11 items-center rounded-l-lg border border-r-0 border-gray-300 bg-gray-50 px-3 text-gray-700"
        >
          {prefix}
        </span>
        {input}
      </div>
    );
  },
);
Input.displayName = 'Input';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('block text-sm font-medium text-gray-800', className)} {...props} />;
}

export interface FormFieldProps {
  id: string;
  label: ReactNode;
  /** Validation message; linked to the input via aria-describedby. */
  error?: string | undefined;
  hint?: ReactNode;
  children: (aria: { id: string; 'aria-describedby'?: string; invalid: boolean }) => ReactNode;
}

/** Label + control + hint/error wiring (NFR-ACCESS-003: errors are announced and linked). */
export function FormField({ id, label, error, hint, children }: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-describedby': describedBy, invalid: Boolean(error) })}
      {hint && !error && (
        <p id={hintId} className="text-sm text-gray-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-danger-600">
          {error}
        </p>
      )}
    </div>
  );
}
