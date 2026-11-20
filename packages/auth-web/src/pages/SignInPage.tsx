import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { isMfaRequired, type MfaRequired } from '@fos/api-client';
import { Alert, Button, FormField, Input, OtpInput, PasswordInput } from '@fos/ui';
import { fullNameSchema, loginBody, otpCodeSchema } from '@fos/validation';
import { AuthLayout, useCountdown } from '../AuthLayout';
import { useAuth, type SignInMethod } from '../context';
import { errorCode, mobileDigitsSchema, toE164, useServerError, useZodForm } from '../form';
import { safeNext } from '../guards';

const METHOD_LABEL: Record<SignInMethod, string> = { otp: 'Mobile number', password: 'Password' };

/** FR-AUTH-004/005/006: OTP and/or password sign-in, with admin MFA. */
export function SignInPage() {
  const { config } = useAuth();
  const [method, setMethod] = useState<SignInMethod>(config.methods[0] ?? 'password');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const done = () => navigate(safeNext(params.get('next'), config.homePath), { replace: true });

  return (
    <AuthLayout
      title="Sign in"
      footer={
        config.allowSignUp && (
          <>
            New here?{' '}
            <Link className="font-medium text-brand-700 underline" to="/sign-up">
              Create an account
            </Link>
          </>
        )
      }
    >
      {notice && <Alert tone="success">{notice}</Alert>}
      {config.methods.length > 1 && (
        <div
          role="tablist"
          aria-label="Sign-in method"
          className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1"
        >
          {config.methods.map((m) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={method === m}
              onClick={() => setMethod(m)}
              className={`h-10 rounded-md text-sm font-medium ${method === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'}`}
            >
              {METHOD_LABEL[m]}
            </button>
          ))}
        </div>
      )}
      {method === 'otp' ? <OtpSignIn onDone={done} /> : <PasswordSignIn onDone={done} />}
    </AuthLayout>
  );
}

function PasswordSignIn({ onDone }: { onDone: () => void }) {
  const { auth } = useAuth();
  const form = useZodForm(loginBody, { identifier: '', password: '' });
  const server = useServerError();
  const [mfa, setMfa] = useState<MfaRequired | null>(null);
  const { errors, isSubmitting } = form.formState;

  if (mfa) return <MfaStep challenge={mfa} onDone={onDone} onRestart={() => setMfa(null)} />;

  const onSubmit = form.handleSubmit(async (values) => {
    server.setMessage(null);
    try {
      const result = await auth.login(values);
      if (isMfaRequired(result)) setMfa(result);
      else onDone();
    } catch (error) {
      server.apply(error);
    }
  });

  return (
    <form noValidate onSubmit={onSubmit} className="space-y-4">
      {server.message && <Alert tone="error">{server.message}</Alert>}
      <FormField id="identifier" label="Email or mobile number" error={errors.identifier?.message}>
        {({ invalid, ...aria }) => (
          <Input
            autoComplete="username"
            invalid={invalid}
            {...aria}
            {...form.register('identifier')}
          />
        )}
      </FormField>
      <FormField id="password" label="Password" error={errors.password?.message}>
        {({ invalid, ...aria }) => (
          <PasswordInput
            autoComplete="current-password"
            invalid={invalid}
            {...aria}
            {...form.register('password')}
          />
        )}
      </FormField>
      <div className="flex justify-end">
        <Link to="/forgot-password" className="text-sm font-medium text-brand-700 underline">
          Forgot password?
        </Link>
      </div>
      <Button type="submit" className="w-full" loading={isSubmitting}>
        Sign in
      </Button>
    </form>
  );
}

const codeForm = z.object({ code: otpCodeSchema });

/** BR-AUTH-018: second factor for the admin app (email code). */
function MfaStep({
  challenge,
  onDone,
  onRestart,
}: {
  challenge: MfaRequired;
  onDone: () => void;
  onRestart: () => void;
}) {
  const { auth } = useAuth();
  const form = useZodForm(codeForm, { code: '' });
  const server = useServerError();
  const onSubmit = form.handleSubmit(async ({ code }) => {
    server.setMessage(null);
    try {
      await auth.completeMfa({ mfaToken: challenge.mfaToken, code });
      onDone();
    } catch (error) {
      server.apply(error);
    }
  });
  return (
    <form noValidate onSubmit={onSubmit} className="space-y-4">
      <Alert tone="info">We emailed you a 6-digit sign-in code.</Alert>
      {server.message && <Alert tone="error">{server.message}</Alert>}
      <FormField id="mfa-code" label="Sign-in code" error={form.formState.errors.code?.message}>
        {({ invalid, ...aria }) => (
          <OtpInput autoFocus invalid={invalid} {...aria} {...form.register('code')} />
        )}
      </FormField>
      <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
        Verify and sign in
      </Button>
      <Button variant="ghost" className="w-full" onClick={onRestart}>
        Didn't get it? Start again
      </Button>
    </form>
  );
}

const phoneForm = z.object({ phone: mobileDigitsSchema });
const newAccountForm = z.object({
  fullName: fullNameSchema,
  acceptTerms: z.literal(true, { message: 'Please accept the terms and privacy policy' }),
});

type OtpStep =
  | { kind: 'phone' }
  | { kind: 'code'; phone: string; signUp?: { fullName: string } }
  | { kind: 'newAccount'; phone: string };

/** FR-AUTH-005: phone + one-time code; first-time numbers create a customer account. */
function OtpSignIn({ onDone }: { onDone: () => void }) {
  const { auth, config } = useAuth();
  const [step, setStep] = useState<OtpStep>({ kind: 'phone' });
  const countdown = useCountdown();
  const server = useServerError();

  const send = async (phone: string) => {
    const result = await auth.requestOtp({ phone, purpose: 'LOGIN' });
    countdown.start(result.resendAfterSeconds);
  };

  if (step.kind === 'phone') {
    return (
      <PhoneStep
        message={server.message}
        onSubmit={async (phone) => {
          server.setMessage(null);
          try {
            await send(phone);
            setStep({ kind: 'code', phone });
          } catch (error) {
            server.apply(error);
          }
        }}
      />
    );
  }

  if (step.kind === 'newAccount') {
    return (
      <NewAccountStep
        phone={step.phone}
        message={server.message}
        resendIn={countdown.seconds}
        onSubmit={async ({ fullName }) => {
          server.setMessage(null);
          try {
            await send(step.phone);
            setStep({ kind: 'code', phone: step.phone, signUp: { fullName } });
          } catch (error) {
            server.apply(error);
          }
        }}
      />
    );
  }

  return (
    <CodeStep
      phone={step.phone}
      message={server.message}
      resendIn={countdown.seconds}
      onResend={async () => {
        server.setMessage(null);
        try {
          await send(step.phone);
        } catch (error) {
          server.apply(error);
        }
      }}
      onChangeNumber={() => setStep({ kind: 'phone' })}
      onSubmit={async (code) => {
        server.setMessage(null);
        try {
          await auth.loginWithOtp({
            phone: step.phone,
            code,
            ...(step.signUp ? { fullName: step.signUp.fullName, acceptTerms: true } : {}),
          });
          onDone();
        } catch (error) {
          // The code is used up either way; a new account needs a name, consent and a fresh code.
          if (errorCode(error) === 'AUTH_TERMS_REQUIRED' && config.allowSignUp) {
            setStep({ kind: 'newAccount', phone: step.phone });
          } else if (errorCode(error) === 'AUTH_TERMS_REQUIRED') {
            server.setMessage('No account uses this number. Ask your administrator for access.');
          } else {
            server.apply(error);
          }
        }
      }}
    />
  );
}

function PhoneStep({
  message,
  onSubmit,
}: {
  message: string | null;
  onSubmit: (phone: string) => Promise<void>;
}) {
  const form = useZodForm(phoneForm, { phone: '' });
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(({ phone }) => onSubmit(toE164(phone)))}
      className="space-y-4"
    >
      {message && <Alert tone="error">{message}</Alert>}
      <FormField
        id="phone"
        label="Mobile number"
        hint="We'll text you a 6-digit code."
        error={form.formState.errors.phone?.message}
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
      <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
        Send code
      </Button>
    </form>
  );
}

function CodeStep(props: {
  phone: string;
  message: string | null;
  resendIn: number;
  onResend: () => Promise<void>;
  onChangeNumber: () => void;
  onSubmit: (code: string) => Promise<void>;
}) {
  const form = useZodForm(codeForm, { code: '' });
  const [resending, setResending] = useState(false);
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(({ code }) => props.onSubmit(code))}
      className="space-y-4"
    >
      <p className="text-sm text-gray-700">
        Enter the code sent to <span className="font-medium">{props.phone}</span>.{' '}
        <button
          type="button"
          className="font-medium text-brand-700 underline"
          onClick={props.onChangeNumber}
        >
          Change
        </button>
      </p>
      {props.message && <Alert tone="error">{props.message}</Alert>}
      <FormField id="otp-code" label="6-digit code" error={form.formState.errors.code?.message}>
        {({ invalid, ...aria }) => (
          <OtpInput autoFocus invalid={invalid} {...aria} {...form.register('code')} />
        )}
      </FormField>
      <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
        Continue
      </Button>
      <Button
        variant="ghost"
        className="w-full"
        disabled={props.resendIn > 0}
        loading={resending}
        onClick={async () => {
          setResending(true);
          await props.onResend().finally(() => setResending(false));
        }}
      >
        {props.resendIn > 0 ? `Resend code in ${props.resendIn}s` : 'Resend code'}
      </Button>
    </form>
  );
}

function NewAccountStep({
  phone,
  message,
  resendIn,
  onSubmit,
}: {
  phone: string;
  message: string | null;
  resendIn: number;
  onSubmit: (v: { fullName: string }) => Promise<void>;
}) {
  const form = useZodForm(newAccountForm, { fullName: '', acceptTerms: false as unknown as true });
  const { errors, isSubmitting } = form.formState;
  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <Alert tone="info" title="Create your account">
        {phone} isn't registered yet. Add your name and we'll send a new code.
      </Alert>
      {message && <Alert tone="error">{message}</Alert>}
      <FormField id="otp-full-name" label="Full name" error={errors.fullName?.message}>
        {({ invalid, ...aria }) => (
          <Input autoComplete="name" invalid={invalid} {...aria} {...form.register('fullName')} />
        )}
      </FormField>
      <TermsCheckbox
        id="otp-terms"
        error={errors.acceptTerms?.message}
        registration={form.register('acceptTerms')}
      />
      <Button type="submit" className="w-full" loading={isSubmitting} disabled={resendIn > 0}>
        {resendIn > 0 ? `Send new code in ${resendIn}s` : 'Send new code'}
      </Button>
    </form>
  );
}

export function TermsCheckbox({
  id,
  error,
  registration,
}: {
  id: string;
  error?: string | undefined;
  registration: object;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-start gap-2 text-sm text-gray-800">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 size-5 accent-brand-700"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          {...registration}
        />
        <span>I accept the terms of service and privacy policy.</span>
      </label>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger-600">
          {error}
        </p>
      )}
    </div>
  );
}
