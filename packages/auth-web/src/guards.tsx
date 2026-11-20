import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Button, ErrorState, Spinner } from '@fos/ui';
import { useAuth, useAuthContext } from './context';

function Restoring() {
  const { restoreError, retryRestore } = useAuthContext();
  if (restoreError) {
    return (
      <ErrorState
        title="Can't reach the server"
        description="Check your connection and try again."
        action={<Button onClick={retryRestore}>Try again</Button>}
      />
    );
  }
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Loading your account" />
    </div>
  );
}

/** Only accepts same-app relative paths, so `next` can't redirect off-site. */
export function safeNext(next: string | null, fallback: string): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

/**
 * Route guard (FR-FE-001): signed-out users go to sign-in with a return path;
 * accounts with an unverified phone finish verification first (BR-AUTH-003).
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Restoring />;
  const here = `${location.pathname}${location.search}`;
  if (status === 'signedOut' || !user) {
    return <Navigate to={`/sign-in?next=${encodeURIComponent(here)}`} replace />;
  }
  if (user.phone && !user.phoneVerified && location.pathname !== '/verify-phone') {
    return <Navigate to={`/verify-phone?next=${encodeURIComponent(here)}`} replace />;
  }
  return children ?? <Outlet />;
}

/** Wraps sign-in/sign-up so signed-in users skip straight to the app. */
export function RedirectIfSignedIn({ children }: { children?: ReactNode }) {
  const { status, config } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Restoring />;
  if (status === 'signedIn') {
    const next = new URLSearchParams(location.search).get('next');
    return <Navigate to={safeNext(next, config.homePath)} replace />;
  }
  return children ?? <Outlet />;
}
