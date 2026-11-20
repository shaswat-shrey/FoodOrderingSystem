import type { ReactNode } from 'react';
import { Card } from '@fos/ui';
import { useAuthContext } from './context';

/** Centred card used by every auth screen. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { config } = useAuthContext();
  return (
    <div className="mx-auto w-full max-w-md py-6">
      <p className="mb-2 text-center text-sm font-semibold text-brand-700">{config.appName}</p>
      <Card className="space-y-5 p-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-gray-600">{subtitle}</p>}
        </div>
        {children}
      </Card>
      {footer && <div className="mt-4 text-center text-sm text-gray-700">{footer}</div>}
    </div>
  );
}

/** Seconds left before a code can be resent; counts down once a second. */
export { useCountdown } from './countdown';
