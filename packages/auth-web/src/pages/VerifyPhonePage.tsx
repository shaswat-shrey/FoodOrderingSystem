import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { Alert, Button, FormField, OtpInput } from '@fos/ui';
import { otpCodeSchema } from '@fos/validation';
import { AuthLayout, useCountdown } from '../AuthLayout';
import { useAuth } from '../context';
import { useServerError, useZodForm } from '../form';
import { safeNext } from '../guards';

const codeForm = z.object({ code: otpCodeSchema });

/** FR-AUTH-002: confirm the phone with the code sent at sign-up. */
export function VerifyPhonePage() {
  const { auth, user, config } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const form = useZodForm(codeForm, { code: '' });
  const server = useServerError();
  const countdown = useCountdown();
  const [resent, setResent] = useState(false);

  const onSubmit = form.handleSubmit(async ({ code }) => {
    server.setMessage(null);
    try {
      await auth.verifyPhone(code);
      navigate(safeNext(params.get('next'), config.homePath), { replace: true });
    } catch (error) {
      server.apply(error);
    }
  });

  const resend = async () => {
    server.setMessage(null);
    try {
      const result = await auth.requestOtp({ purpose: 'VERIFY_PHONE' });
      countdown.start(result.resendAfterSeconds);
      setResent(true);
    } catch (error) {
      server.apply(error);
    }
  };

  return (
    <AuthLayout
      title="Verify your mobile number"
      subtitle={<>We sent a 6-digit code to {user?.phone}.</>}
    >
      <form noValidate onSubmit={onSubmit} className="space-y-4">
        {resent && !server.message && <Alert tone="success">New code sent.</Alert>}
        {server.message && <Alert tone="error">{server.message}</Alert>}
        <FormField
          id="verify-code"
          label="6-digit code"
          error={form.formState.errors.code?.message}
        >
          {({ invalid, ...aria }) => (
            <OtpInput autoFocus invalid={invalid} {...aria} {...form.register('code')} />
          )}
        </FormField>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Verify
        </Button>
        <Button
          variant="ghost"
          className="w-full"
          disabled={countdown.seconds > 0}
          onClick={resend}
        >
          {countdown.seconds > 0 ? `Resend code in ${countdown.seconds}s` : 'Resend code'}
        </Button>
        <Button variant="ghost" className="w-full" onClick={() => void auth.logout()}>
          Sign out
        </Button>
      </form>
    </AuthLayout>
  );
}
