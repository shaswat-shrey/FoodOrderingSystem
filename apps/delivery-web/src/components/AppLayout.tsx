import { Link, NavLink, Outlet } from 'react-router';
import { AccountActions, useAuth } from '@fos/auth-web';
import { cn } from '@fos/ui';
import { APP_INFO } from '../app-info';
import { LiveNotices } from './LiveNotices';

const TABS = [
  { to: '/', label: 'Shift', end: true },
  { to: '/earnings', label: 'Earnings', end: false },
  { to: '/history', label: 'Trips', end: false },
  { to: '/account/bank', label: 'Bank', end: false },
  { to: '/account/profile', label: 'Profile', end: false },
];

export function AppLayout() {
  const signedIn = useAuth().status === 'signedIn';
  return (
    <div className="min-h-dvh bg-gray-50 pb-20">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-xl items-center justify-between gap-2 px-4">
          <Link to="/" className="text-lg font-bold text-brand-700">
            {APP_INFO.title}
          </Link>
          <AccountActions />
        </div>
      </header>
      {signedIn && <LiveNotices />}
      <main id="main" className="mx-auto max-w-xl px-4 py-6">
        <Outlet />
      </main>
      {signedIn && (
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white"
        >
          <ul className="mx-auto grid max-w-xl grid-cols-5">
            {TABS.map((t) => (
              <li key={t.to}>
                <NavLink
                  to={t.to}
                  end={t.end}
                  className={({ isActive }) =>
                    cn(
                      'flex h-14 items-center justify-center text-sm font-medium',
                      isActive ? 'text-brand-700' : 'text-gray-600',
                    )
                  }
                >
                  {t.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
