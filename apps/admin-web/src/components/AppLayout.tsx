import { NavLink, Outlet } from 'react-router';
import { AccountActions, useAuth } from '@fos/auth-web';
import { cn } from '@fos/ui';
import { APP_INFO } from '../app-info';
import { usePermissions } from '../lib/permissions';

interface NavItem {
  to: string;
  label: string;
  /** Shown when the admin holds any of these platform permissions. */
  perms: string[];
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Operations',
    items: [
      { to: '/', label: 'Dashboard', perms: ['dashboard:read'] },
      { to: '/orders', label: 'Orders', perms: ['order:read:any'] },
      { to: '/dispatch', label: 'Dispatch', perms: ['dispatch:read'] },
      { to: '/support', label: 'Support desk', perms: ['support:read'] },
    ],
  },
  {
    group: 'Accounts',
    items: [
      { to: '/approvals', label: 'Approvals', perms: ['restaurant:review', 'partner:review'] },
      { to: '/users', label: 'Users', perms: ['user:read'] },
      { to: '/restaurants', label: 'Restaurants', perms: ['restaurant:read'] },
      { to: '/change-requests', label: 'Change requests', perms: ['restaurant:review'] },
      { to: '/partners', label: 'Partners', perms: ['partner:read'] },
      { to: '/reviews', label: 'Review moderation', perms: ['review:moderate'] },
    ],
  },
  {
    group: 'Finance',
    items: [
      { to: '/payments', label: 'Payments', perms: ['payment:read'] },
      { to: '/refunds', label: 'Refunds', perms: ['refund:read'] },
      { to: '/payouts', label: 'Payouts', perms: ['payout:read'] },
    ],
  },
  {
    group: 'Configuration',
    items: [
      { to: '/coupons', label: 'Coupons', perms: ['coupon:read'] },
      { to: '/zones', label: 'Zones', perms: ['zone:read'] },
      {
        to: '/pricing',
        label: 'Pricing plans',
        perms: ['pricing:read', 'commission:read', 'earnings:read'],
      },
      { to: '/settings', label: 'Settings', perms: ['settings:read'] },
    ],
  },
  {
    group: 'Governance',
    items: [
      { to: '/roles', label: 'Roles & admins', perms: ['iam:read'] },
      { to: '/audit', label: 'Audit log', perms: ['audit:read'] },
      { to: '/jobs', label: 'Failed jobs', perms: ['ops:jobs'] },
    ],
  },
];

function Sidebar() {
  const { can } = usePermissions();
  return (
    <nav
      aria-label="Admin sections"
      className="flex gap-4 overflow-x-auto border-b border-gray-200 bg-white px-4 py-2 md:block md:w-56 md:shrink-0 md:space-y-4 md:overflow-visible md:border-b-0 md:border-r md:py-4"
    >
      {NAV.map(({ group, items }) => {
        const visible = items.filter((i) => i.perms.some(can));
        if (visible.length === 0) return null;
        return (
          <div key={group} className="shrink-0">
            <p className="hidden px-2 text-xs font-semibold uppercase tracking-wide text-gray-500 md:block">
              {group}
            </p>
            <ul className="flex gap-1 md:mt-1 md:block md:space-y-0.5">
              {visible.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    end={i.to === '/'}
                    className={({ isActive }) =>
                      cn(
                        'block whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium',
                        isActive ? 'bg-brand-50 text-brand-800' : 'text-gray-700 hover:bg-gray-100',
                      )
                    }
                  >
                    {i.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function AppLayout() {
  const { status } = useAuth();
  const signedIn = status === 'signedIn';
  return (
    <div className="min-h-dvh bg-gray-50">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-gray-200 bg-white">
        <div className="flex h-14 items-center justify-between gap-2 px-4">
          <span className="text-lg font-bold text-brand-700">{APP_INFO.title}</span>
          <AccountActions />
        </div>
      </header>
      <div className={signedIn ? 'md:flex' : undefined}>
        {signedIn && <Sidebar />}
        <main id="main" className="mx-auto w-full max-w-7xl min-w-0 flex-1 px-4 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
