import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert, Spinner } from '@fos/ui';
import { AuthLayout } from '../AuthLayout';
import { useAuth } from '../context';

/** FR-AUTH-008: opened from the emailed link. */
export function VerifyEmailPage() {
  const { auth, status, config, api } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<
    { kind: 'working' } | { kind: 'done' } | { kind: 'failed'; message: string }
  >(
    token
      ? { kind: 'working' }
      : { kind: 'failed', message: 'This link is incomplete. Open it again from your email.' },
  );
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true; // tokens are single-use; StrictMode must not send it twice
    auth.verifyEmail(token).then(
      () => setState({ kind: 'done' }),
      (error: unknown) => setState({ kind: 'failed', message: (error as Error).message }),
    );
  }, [auth, token]);

  useEffect(() => {
    if (state.kind === 'done' && status === 'signedIn') {
      void auth.me().then(
        (user) => api.authStore.setState({ user }),
        () => undefined,
      );
    }
  }, [state.kind, status, auth, api]);

  return (
    <AuthLayout title="Verify your email">
      {state.kind === 'working' && (
        <div className="flex justify-center py-6">
          <Spinner label="Verifying your email" />
        </div>
      )}
      {state.kind === 'done' && (
        <Alert tone="success" title="Email verified">
          Thanks — your email address is confirmed.
        </Alert>
      )}
      {state.kind === 'failed' && (
        <Alert tone="error" title="Couldn't verify your email">
          {state.message}
        </Alert>
      )}
      <Link
        to={status === 'signedIn' ? config.homePath : '/sign-in'}
        className="block text-center font-medium text-brand-700 underline"
      >
        {status === 'signedIn' ? 'Continue' : 'Go to sign in'}
      </Link>
    </AuthLayout>
  );
}
