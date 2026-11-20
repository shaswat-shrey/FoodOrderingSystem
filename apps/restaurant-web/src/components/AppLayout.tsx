import { NavLink, Outlet } from 'react-router';
import { AccountActions, useAuth } from '@fos/auth-web';
import { APP_INFO } from '../app-info';
import { useWorkspace, WorkspaceProvider } from '../lib/workspace';

const NAV = [
  { to: '/orders', label: 'Orders', perm: 'rest.order:read' },
  { to: '/kitchen', label: 'Kitchen', perm: 'rest.kds:view' },
  { to: '/menu', label: 'Menu', perm: 'rest.menu:read' },
  { to: '/outlet', label: 'Outlet', perm: 'rest.branch:read' },
  { to: '/team', label: 'Team', perm: 'rest.staff:read' },
  { to: '/dashboard', label: 'Dashboard', perm: 'rest.analytics:read' },
  { to: '/analytics', label: 'Analytics', perm: 'rest.analytics:read' },
  { to: '/reviews', label: 'Reviews', perm: 'rest.review:read' },
  { to: '/payouts', label: 'Payouts', perm: 'rest.finance:read' },
  { to: '/profile', label: 'Profile', perm: 'rest.restaurant:read' },
];

function WorkspaceBar() {
  const { restaurant, me, branchId, selectBranch, selectRestaurant, can } = useWorkspace();
  if (!restaurant) return null;
  return (
    <div className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
        {me && me.restaurants.length > 1 ? (
          <select
            aria-label="Restaurant"
            value={restaurant.id}
            onChange={(e) => selectRestaurant(e.target.value)}
            className="h-9 rounded border border-gray-300 px-2 text-sm"
          >
            {me.restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-semibold">{restaurant.name}</span>
        )}
        {restaurant.branches.length > 0 && (
          <select
            aria-label="Outlet"
            value={branchId ?? ''}
            onChange={(e) => selectBranch(e.target.value)}
            className="h-9 rounded border border-gray-300 px-2 text-sm"
          >
            {restaurant.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <nav aria-label="Sections" className="ml-auto flex flex-wrap gap-1">
          {NAV.filter((n) => can(n.perm)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-800' : 'text-gray-700 hover:bg-gray-100'}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

function Shell() {
  const { status } = useAuth();
  return (
    <div className="min-h-dvh bg-gray-50">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4">
          <span className="text-lg font-bold text-brand-700">{APP_INFO.title}</span>
          <AccountActions />
        </div>
      </header>
      {status === 'signedIn' && <WorkspaceBar />}
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}

export function AppLayout() {
  const { status } = useAuth();
  // Workspace data needs a session; signed-out pages (sign-in, invitation preview) don't.
  return status === 'signedIn' ? (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  ) : (
    <Shell />
  );
}
