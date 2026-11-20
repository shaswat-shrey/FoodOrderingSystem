import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { Alert, Button, FormField, Input, OtpInput, PasswordInput } from '@fos/ui';
import { forgotPasswordBody, newPasswordSchema, otpCodeSchema } from '@fos/validation';
import { AuthLayout } from '../AuthLayout';
import { useAuth } from '../context';
import { errorCode, mobileDigitsSchema, toE164, useServerError, useZodForm } from '../form';

const backToSignIn = (
  <Link className="font-medium text-brand-700 underline" to="/sign-in">
    Back to sign in
  </Link>
);

/** FR-AUTH-011: the same answer whether or not the account exists (no enumeration). */
export function ForgotPasswordPage() {
  const { auth } = useAuth();
  const navigate = useNavigate();
  const form = useZodForm(forgotPasswordBody, { identifier: '' });
  const server = useServerError();
  const [emailSent, setEmailSent] = useState(false);

  const onSubmit = form.handleSubmit(async ({ identifier }) => {
    server.setMessage(null);
    try {
      await auth.forgotPassword(identifier);
      const phone = mobileDigitsSchema.safeParse(identifier);
      if (!identifier.includes('@') && phone.success) {
        navigate('/reset-password', { state: { phone: phone.data } });
      } else {
        setEmailSent(true);
      }
    } catch (error) {
      server.apply(error);
    }
  });

  return (
    <AuthLayout title="Reset your password" footer={backToSignIn}>
      {emailSent ? (
        <Alert tone="success" title="Check your email">
          If an account uses that address, we've sent a link to reset your password. It expires
          soon.
        </Alert>
      ) : (
        <form noValidate onSubmit={onSubmit} className="space-y-4">
          {server.message && <Alert tone="error">{server.message}</Alert>}
          <FormField
            id="identifier"
            label="Email or mobile number"
            hint="We'll email you a link, or text you a code."
            error={form.formState.errors.identifier?.message}
          >
            {({ invalid, ...aria }) => (
              <Input
                autoComplete="username"
                invalid={invalid}
                {...aria}
                {...form.register('identifier')}
              />
            )}
          </FormField>
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
            Continue
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

const linkResetForm = z.object({ newPassword: newPasswordSchema });
const codeResetForm = z.object({
  phone: mobileDigitsSchema,
  code: otpCodeSchema,
  newPassword: newPasswordSchema,
});

/** FR-AUTH-012: by emailed link (?token=) or by phone code. Signs out every device. */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const phone = (useLocation().state as { phone?: string } | null)?.phone ?? '';
  return (
    <AuthLayout title="Choose a new password" footer={backToSignIn}>
      {token ? <LinkReset token={token} /> : <CodeReset phone={phone} />}
    </AuthLayout>
  );
}

function useResetSubmit() {
  const { auth } = useAuth();
  const navigate = useNavigate();
  const server = useServerError();
  const submit = async (
    body: { token?: string; phone?: string; code?: string; newPassword: string },
    setPasswordError: (message: string) => void,
  ) => {
    server.setMessage(null);
    try {
      await auth.resetPassword(body);
      navigate('/sign-in', {
        replace: true,
        state: { notice: 'Password changed. Sign in with your new password.' },
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'AUTH_PASSWORD_WEAK' || code === 'AUTH_PASSWORD_BREACHED')
        setPasswordError((error as Error).message);
      else server.apply(error);
    }
  };
  return { server, submit };
}

function LinkReset({ token }: { token: string }) {
  const form = useZodForm(linkResetForm, { newPassword: '' });
  const { server, submit } = useResetSubmit();
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={form.handleSubmit(({ newPassword }) =>
        submit({ token, newPassword }, (message) => form.setError('newPassword', { message })),
      )}
    >
      {server.message && <Alert tone="error">{server.message}</Alert>}
      <NewPasswordField
        error={form.formState.errors.newPassword?.message}
        registration={form.register('newPassword')}
      />
      <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
        Save password
      </Button>
    </form>
  );
}

function CodeReset({ phone }: { phone: string }) {
  const form = useZodForm(codeResetForm, { phone, code: '', newPassword: '' });
  const { server, submit } = useResetSubmit();
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={form.handleSubmit((v) =>
        submit({ phone: toE164(v.phone), code: v.code, newPassword: v.newPassword }, (message) =>
          form.setError('newPassword', { message }),
        ),
      )}
    >
      {phone && (
        <Alert tone="info">If this number has an account, we've texted it a 6-digit code.</Alert>
      )}
      {server.message && <Alert tone="error">{server.message}</Alert>}
      <FormField id="reset-phone" label="Mobile number" error={errors.phone?.message}>
        {({ invalid, ...aria }) => (
          <Input
            prefix="+91"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            invalid={invalid}
            {...aria}
            {...form.register('phone')}
          />
        )}
      </FormField>
      <FormField id="reset-code" label="6-digit code" error={errors.code?.message}>
        {({ invalid, ...aria }) => (
          <OtpInput invalid={invalid} {...aria} {...form.register('code')} />
        )}
      </FormField>
      <NewPasswordField
        error={errors.newPassword?.message}
        registration={form.register('newPassword')}
      />
      <Button type="submit" className="w-full" loading={isSubmitting}>
        Save password
      </Button>
    </form>
  );
}

function NewPasswordField({
  error,
  registration,
}: {
  error?: string | undefined;
  registration: object;
}) {
  return (
    <FormField
      id="new-password"
      label="New password"
      hint="At least 8 characters. Avoid common passwords."
      error={error}
    >
      {({ invalid, ...aria }) => (
        <PasswordInput autoComplete="new-password" invalid={invalid} {...aria} {...registration} />
      )}
    </FormField>
  );
}
