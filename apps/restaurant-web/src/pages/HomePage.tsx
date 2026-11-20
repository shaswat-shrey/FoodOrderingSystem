import { Navigate } from 'react-router';
import { ErrorState, Spinner } from '@fos/ui';
import { useWorkspace } from '../lib/workspace';
import { OnboardingPage } from './OnboardingPage';

/** Members land on orders (or the kitchen for kitchen staff); everyone else on onboarding. */
export function HomePage() {
  const { me, loading, error, restaurant, refresh } = useWorkspace();
  if (loading) return <Spinner />;
  if (error || !me)
    return (
      <ErrorState
        title="Couldn’t load your restaurants"
        action={
          <button className="underline" onClick={() => void refresh()}>
            Try again
          </button>
        }
      />
    );
  if (!restaurant) return <OnboardingPage />;
  if (restaurant.role === 'KITCHEN') return <Navigate to="/kitchen" replace />;
  return <Navigate to="/orders" replace />;
}
