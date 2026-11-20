import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { AccountActions, useAuth } from '@fos/auth-web';
import { cn } from '@fos/ui';
import { useUnreadCount } from '../lib/notifications';

/** The account area's sections, shared by the header menu and the /account hub. */
export const ACCOUNT_LINKS = [
  { to: '/orders', label: 'Orders', icon: '🧾' },
  { to: '/account/reviews', label: 'Reviews', icon: '★' },
  { to: '/account/favourites', label: 'Favourites', icon: '♥' },
  { to: '/account/addresses', label: 'Addresses', icon: '📍' },
  { to: '/account/wallet', label: 'Wallet', icon: '👛' },
  { to: '/notifications', label: 'Notifications', icon: '🔔' },
  { to: '/help', label: 'Help', icon: '💬' },
  { to: '/account/profile', label: 'Profile', icon: '👤' },
] as const;

function Bell({ unread }: { unread: number }) {
  return (
    <Link
      to="/notifications"
      className="relative flex h-11 w-11 items-center justify-center rounded-lg text-lg hover:bg-gray-100"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
    >
      <span aria-hidden="true">🔔</span>
      {unread > 0 && (
        <span
          data-testid="unread-badge"
          aria-hidden="true"
          className="absolute right-1 top-1 min-w-5 rounded-full bg-danger-600 px-1 text-center text-xs font-semibold leading-5 text-white"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}

/**
 * Header account controls: notifications bell with unread badge and an account
 * menu (a full-width sheet on phones). Guests get the shared "Sign in" link.
 */
export function AccountMenu() {
  const { status, user, auth } = useAuth();
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  if (status !== 'signedIn' || !user) return <AccountActions />;
  return (
    <div ref={ref} className="flex shrink-0 items-center gap-1">
      <Bell unread={unread} />
      <button
        type="button"
        className="flex h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-gray-800 hover:bg-gray-100"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">👤</span>
        <span className="hidden max-w-32 truncate sm:inline">{user.fullName || 'Account'}</span>
        <span className="sr-only sm:hidden">Account</span>
        <span aria-hidden="true" className="text-xs">
          ▾
        </span>
      </button>
      {open && (
        <nav
          id={menuId}
          aria-label="Account"
          className="absolute inset-x-0 top-14 z-30 border-b border-gray-200 bg-white shadow-lg sm:inset-x-auto sm:right-4 sm:w-64 sm:rounded-xl sm:border"
        >
          <ul className="py-1">
            {ACCOUNT_LINKS.map((l) => (
              <li key={l.to}>
                <NavLink
                  to={l.to}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-11 items-center gap-3 px-4 text-sm hover:bg-gray-50',
                      isActive ? 'font-semibold text-brand-700' : 'text-gray-800',
                    )
                  }
                >
                  <span aria-hidden="true" className="w-5 text-center">
                    {l.icon}
                  </span>
                  {l.label}
                  {l.to === '/notifications' && unread > 0 && (
                    <span className="ml-auto rounded-full bg-danger-600 px-2 text-xs text-white">
                      {unread}
                    </span>
                  )}
                </NavLink>
              </li>
            ))}
            <li className="border-t border-gray-100">
              <Link
                to="/account/security"
                className="flex min-h-11 items-center gap-3 px-4 text-sm text-gray-800 hover:bg-gray-50"
              >
                <span aria-hidden="true" className="w-5 text-center">
                  🔒
                </span>
                Sign-in & security
              </Link>
            </li>
            <li>
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm text-gray-800 hover:bg-gray-50"
                onClick={async () => {
                  setOpen(false);
                  await auth.logout().catch(() => undefined);
                  navigate('/sign-in', { replace: true });
                }}
              >
                <span aria-hidden="true" className="w-5 text-center">
                  ↩
                </span>
                Sign out
              </button>
            </li>
          </ul>
        </nav>
      )}
    </div>
  );
}
