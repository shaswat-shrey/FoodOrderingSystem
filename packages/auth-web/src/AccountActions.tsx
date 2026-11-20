import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@fos/ui';
import { useAuth } from './context';

/** Header control: "Sign in" when signed out; name, security link and sign-out when signed in. */
export function AccountActions() {
  const { status, user, auth } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  if (status === 'loading') return null;
  if (status !== 'signedIn' || !user) {
    return (
      <Link
        to="/sign-in"
        className="rounded-lg px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
      >
        Sign in
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Link
        to="/account/security"
        className="max-w-40 truncate rounded-lg px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100"
        title="Sign-in and security"
      >
        {user.fullName || 'Account'}
      </Link>
      <Button
        variant="ghost"
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await auth.logout().catch(() => undefined);
          navigate('/sign-in', { replace: true });
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
