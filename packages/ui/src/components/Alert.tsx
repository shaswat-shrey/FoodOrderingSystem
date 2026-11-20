import type { ReactNode } from 'react';
import { cn } from '../cn';

const tones = {
  error: 'border-red-200 bg-red-50 text-danger-600',
  success: 'border-green-200 bg-green-50 text-success-600',
  info: 'border-blue-200 bg-blue-50 text-info-600',
  warning: 'border-amber-200 bg-amber-50 text-warning-600',
} as const;

export interface AlertProps {
  tone?: keyof typeof tones;
  title?: string;
  children?: ReactNode;
  className?: string;
}

/** Inline banner; errors use role="alert" so they are announced (NFR-ACCESS-003). */
export function Alert({ tone = 'info', title, children, className }: AlertProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('rounded-lg border px-3 py-2 text-sm', tones[tone], className)}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cn(title && 'mt-0.5', 'text-gray-800')}>{children}</div>}
    </div>
  );
}
