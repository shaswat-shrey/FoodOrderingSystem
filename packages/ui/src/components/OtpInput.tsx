import { forwardRef } from 'react';
import { Input, type InputProps } from './Input';

/**
 * Six-digit code field. A single input (not six boxes) so screen readers,
 * paste and SMS autofill (autocomplete="one-time-code") all just work.
 */
export const OtpInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'prefix'>>(
  ({ className, ...props }, ref) => (
    <Input
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      className={`text-center text-xl tracking-[0.5em] ${className ?? ''}`}
      {...props}
    />
  ),
);
OtpInput.displayName = 'OtpInput';
