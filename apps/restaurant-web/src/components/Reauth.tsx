import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { isApiClientError } from '@fos/api-client';
import { useAuth } from '@fos/auth-web';
import { Alert, Button } from '@fos/ui';
import { api } from '../lib/api';
import { Field, ServerError } from './fields';

export const needsReauth = (error: unknown) =>
  isApiClientError(error) && error.code === 'AUTH_REAUTH_REQUIRED';

/**
 * BR-AUTH-017: legal, tax and bank changes need a fresh confirmation. Sends a code to
 * the signed-in phone (or takes the password), confirms it, then calls `onConfirmed`
 * so the caller can retry the change.
 */
export function ReauthPrompt({ onConfirmed, busy }: { onConfirmed: () => void; busy?: boolean }) {
  const { user } = useAuth();
  const [usePassword, setUsePassword] = useState(!user?.phone);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const sendCode = useMutation({
    mutationFn: () => api.post('/auth/otp/request', { phone: user?.phone, purpose: 'LOGIN' }),
  });
  const confirm = useMutation({
    mutationFn: () => api.post('/auth/reauth', usePassword ? { password } : { code }),
    onSuccess: onConfirmed,
  });
  return (
    <Alert tone="info" title="Confirm it’s you">
      {usePassword ? 'Enter your password to continue.' : 'We’ll send a code to your phone.'}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        {usePassword ? (
          <Field
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        ) : (
          <>
            <Button
              size="sm"
              variant="secondary"
              loading={sendCode.isPending}
              onClick={() => sendCode.mutate()}
            >
              {sendCode.isSuccess ? 'Resend code' : 'Send code'}
            </Button>
            <Field
              label="Code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </>
        )}
        <Button
          size="sm"
          loading={confirm.isPending || busy}
          disabled={usePassword ? !password : code.length < 4}
          onClick={() => confirm.mutate()}
        >
          Confirm and send
        </Button>
      </div>
      {user?.phone && (
        <button
          type="button"
          className="mt-2 text-sm underline"
          onClick={() => setUsePassword((v) => !v)}
        >
          {usePassword ? 'Use a code instead' : 'Use my password instead'}
        </button>
      )}
      <ServerError error={confirm.error ?? sendCode.error} />
    </Alert>
  );
}
