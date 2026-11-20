import { Link } from 'react-router';
import { useAuth } from '@fos/auth-web';
import { ACCOUNT_LINKS } from '../components/AccountMenu';
import { PageTitle } from '../components/account-ui';

/** Account hub: every account section, one tap away on phones. */
export function AccountPage() {
  const { user } = useAuth();
  return (
    <div>
      <PageTitle>
        {user?.fullName ? `Hi, ${user.fullName.split(' ')[0]}` : 'Your account'}
      </PageTitle>
      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white shadow-sm">
        {[
          ...ACCOUNT_LINKS,
          { to: '/account/security', label: 'Sign-in & security', icon: '🔒' },
        ].map((l) => (
          <li key={l.to}>
            <Link
              to={l.to}
              className="flex min-h-12 items-center gap-3 px-4 text-gray-900 hover:bg-gray-50"
            >
              <span aria-hidden="true" className="w-5 text-center">
                {l.icon}
              </span>
              <span className="flex-1">{l.label}</span>
              <span aria-hidden="true" className="text-gray-400">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
