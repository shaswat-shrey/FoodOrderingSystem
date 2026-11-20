import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { DeviceSession } from '@fos/api-client';
import { Alert, Button, Card, FormField, PasswordInput, Spinner } from '@fos/ui';
import { changePasswordBody } from '@fos/validation';
import { useAuth } from '../context';
import { errorCode, useServerError, useZodForm } from '../form';

const APP_LABEL: Record<string, string> = {
  CUSTOMER: 'Customer app',
  RESTAURANT: 'Restaurant app',
  DELIVERY: 'Delivery app',
  ADMIN: 'Admin console',
};

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));

/** FR-AUTH-013/014/015: signed-in devices, sign out elsewhere, change password. */
export function AccountSecurityPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Sign-in and security</h1>
      <DevicesCard />
      <ChangePasswordCard />
    </div>
  );
}

function DevicesCard() {
  const { auth } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    auth
      .sessions()
      .then(setSessions, (error: unknown) =>
        setMessage({ tone: 'error', text: (error as Error).message }),
      );
  }, [auth]);
  useEffect(load, [load]);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await action();
      setMessage({ tone: 'success', text: success });
      load();
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">Where you're signed in</h2>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {!sessions ? (
        <Spinner label="Loading devices" />
      ) : (
        <ul className="divide-y divide-gray-200">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-medium text-gray-900">
                  {s.device}{' '}
                  {s.current && (
                    <span className="ml-1 rounded bg-green-50 px-1.5 py-0.5 text-xs text-success-600">
                      This device
                    </span>
                  )}
                </p>
                <p className="text-sm text-gray-600">
                  {APP_LABEL[s.app] ?? s.app} · last active {formatTime(s.lastActiveAt)}
                  {s.ip && ` · ${s.ip}`}
                </p>
              </div>
              {!s.current && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === s.id}
                  onClick={() => run(s.id, () => auth.revokeSession(s.id), 'Device signed out.')}
                >
                  Sign out<span className="sr-only"> {s.device}</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={busy === 'others'}
          disabled={!sessions || sessions.length < 2}
          onClick={() =>
            run('others', () => auth.logoutAll(true), 'Signed out of all other devices.')
          }
        >
          Sign out other devices
        </Button>
        <Button
          variant="danger"
          loading={busy === 'all'}
          onClick={async () => {
            setBusy('all');
            try {
              await auth.logoutAll(false);
              navigate('/sign-in', { replace: true });
            } catch (error) {
              setMessage({ tone: 'error', text: (error as Error).message });
              setBusy(null);
            }
          }}
        >
          Sign out everywhere
        </Button>
      </div>
    </Card>
  );
}

function ChangePasswordCard() {
  const { auth } = useAuth();
  const [done, setDone] = useState(false);
  const form = useZodForm(changePasswordBody, { currentPassword: '', newPassword: '' });
  const server = useServerError();
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    server.setMessage(null);
    setDone(false);
    try {
      await auth.changePassword(values);
      // The API keeps this session and signs out every other device.
      form.reset();
      setDone(true);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'AUTH_INVALID_CREDENTIALS')
        form.setError('currentPassword', { message: 'Your current password is incorrect.' });
      else if (code === 'AUTH_PASSWORD_WEAK' || code === 'AUTH_PASSWORD_BREACHED')
        form.setError('newPassword', { message: (error as Error).message });
      else server.apply(error);
    }
  });

  return (
    <Card>
      <form noValidate onSubmit={onSubmit} className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Change password</h2>
        <p className="text-sm text-gray-600">
          Signed up with a one-time code and never set a password? Sign out and use “Forgot
          password” to create one.
        </p>
        {done && (
          <Alert tone="success">Password changed. Your other devices have been signed out.</Alert>
        )}
        {server.message && <Alert tone="error">{server.message}</Alert>}
        <FormField
          id="current-password"
          label="Current password"
          error={errors.currentPassword?.message}
        >
          {({ invalid, ...aria }) => (
            <PasswordInput
              autoComplete="current-password"
              invalid={invalid}
              {...aria}
              {...form.register('currentPassword')}
            />
          )}
        </FormField>
        <FormField
          id="change-new-password"
          label="New password"
          error={errors.newPassword?.message}
        >
          {({ invalid, ...aria }) => (
            <PasswordInput
              autoComplete="new-password"
              invalid={invalid}
              {...aria}
              {...form.register('newPassword')}
            />
          )}
        </FormField>
        <Button type="submit" loading={isSubmitting}>
          Change password
        </Button>
      </form>
    </Card>
  );
}
