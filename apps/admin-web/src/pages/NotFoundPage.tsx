import { Link } from 'react-router';
import { EmptyState } from '@fos/ui';

export function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      description="The page you’re looking for doesn’t exist or has moved."
      action={
        <Link to="/" className="font-medium text-brand-700 underline underline-offset-2">
          Go to the dashboard
        </Link>
      }
    />
  );
}
