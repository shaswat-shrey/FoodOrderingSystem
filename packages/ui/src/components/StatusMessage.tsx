import type { ReactNode } from 'react';
import { cn } from '../cn';

interface StatusMessageProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Empty state (FR-FE-005): nothing to show yet, with an optional next step. */
export function EmptyState({ title, description, action, className }: StatusMessageProps) {
  return (
    <div className={cn('flex flex-col items-center gap-2 py-10 text-center', className)}>
      <p className="text-base font-semibold text-gray-900">{title}</p>
      {description && <div className="max-w-md text-sm text-gray-600">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Error state (FR-FE-005, NFR-UX-003): says what happened and offers recovery. */
export function ErrorState({ title, description, action, className }: StatusMessageProps) {
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-2 py-10 text-center', className)}>
      <p className="text-base font-semibold text-danger-600">{title}</p>
      {description && <div className="max-w-md text-sm text-gray-600">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
