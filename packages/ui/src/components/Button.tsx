import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn';
import { Spinner } from './Spinner';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
  {
    variants: {
      variant: {
        // brand-700 keeps white text at >= 4.5:1 (NFR-ACCESS-001); brand-600 is only 3.55:1.
        primary: 'bg-brand-700 text-white hover:bg-brand-800',
        secondary: 'border border-gray-300 bg-white text-gray-900 hover:bg-gray-50',
        ghost: 'text-gray-700 hover:bg-gray-100',
        danger: 'bg-danger-600 text-white hover:bg-red-800',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-sm', // ≥ 44 px touch target (NFR-UX-005)
        lg: 'h-12 px-6 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, loading = false, disabled, children, type = 'button', ...props },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner label="Please wait" />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
