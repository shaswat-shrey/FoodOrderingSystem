import { Link, Outlet } from 'react-router';
import { AccountActions } from '@fos/auth-web';
import { APP_INFO } from '../app-info';

export function AppLayout() {
  return (
    <div className="min-h-dvh bg-gray-50">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 px-4">
          <Link to="/" className="text-lg font-bold text-brand-700">
            {APP_INFO.title}
          </Link>
          <AccountActions />
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
