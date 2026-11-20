import { Link, useNavigate } from 'react-router';
import type { z } from 'zod';
import { Alert, Button, FormField, Input, PasswordInput } from '@fos/ui';
import { registerBody } from '@fos/validation';
import { AuthLayout } from '../AuthLayout';
import { useAuth } from '../context';
import { errorCode, mobileDigitsSchema, toE164, useServerError, useZodForm } from '../form';
import { TermsCheckbox } from './SignInPage';

const signUpForm = registerBody.safeExtend({ phone: mobileDigitsSchema });

/** FR-AUTH-001: email + phone + password registration; the phone is verified next. */
export function SignUpPage() {
  const { auth } = useAuth();
  const navigate = useNavigate();
  const form = useZodForm(signUpForm, {
    fullName: '',
    email: '',
    phone: '',
    password: '',
    acceptTerms: false as unknown as true,
  });
  const server = useServerError<z.input<typeof signUpForm>>();
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    server.setMessage(null);
    try {
      await auth.register({ ...values, phone: toE164(values.phone) });
      navigate('/verify-phone', { replace: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'AUTH_PASSWORD_WEAK' || code === 'AUTH_PASSWORD_BREACHED') {
        form.setError('password', { type: 'server', message: (error as Error).message });
      } else {
        server.apply(error, form.setError);
      }
    }
  });

  return (
    <AuthLayout
      title="Create your account"
      footer={
        <>
          Already have an account?{' '}
          <Link className="font-medium text-brand-700 underline" to="/sign-in">
            Sign in
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit} className="space-y-4">
        {server.message && <Alert tone="error">{server.message}</Alert>}
        <FormField id="full-name" label="Full name" error={errors.fullName?.message}>
          {({ invalid, ...aria }) => (
            <Input autoComplete="name" invalid={invalid} {...aria} {...form.register('fullName')} />
          )}
        </FormField>
        <FormField id="email" label="Email" error={errors.email?.message}>
          {({ invalid, ...aria }) => (
            <Input
              type="email"
              autoComplete="email"
              invalid={invalid}
              {...aria}
              {...form.register('email')}
            />
          )}
        </FormField>
        <FormField
          id="phone"
          label="Mobile number"
          hint="We'll text you a code to verify it."
          error={errors.phone?.message}
        >
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
        <FormField
          id="password"
          label="Password"
          hint="At least 8 characters. Avoid common passwords."
          error={errors.password?.message}
        >
          {({ invalid, ...aria }) => (
            <PasswordInput
              autoComplete="new-password"
              invalid={invalid}
              {...aria}
              {...form.register('password')}
            />
          )}
        </FormField>
        <TermsCheckbox
          id="terms"
          error={errors.acceptTerms?.message}
          registration={form.register('acceptTerms')}
        />
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
