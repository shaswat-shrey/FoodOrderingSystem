import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation, useRoutes, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '@fos/api-client';
import { AuthProvider, authRoutes, RequireAuth, safeNext, type AuthConfig } from './index';

type Reply = { status: number; data: unknown };
type Handler = (url: string, body: Record<string, unknown>) => Reply | undefined;

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  fullName: 'Asha Rao',
  email: 'asha@example.com',
  phone: '+919800000001',
  emailVerified: true,
  phoneVerified: true,
  status: 'ACTIVE',
  roles: ['CUSTOMER'],
  scope: 'FULL',
  profileComplete: true,
  ...over,
});
const ok = (data: unknown): Reply => ({
  status: 200,
  data: { success: true, message: 'OK', data, meta: {} },
});
const fail = (status: number, code: string, message = code): Reply => ({
  status,
  data: { success: false, message, error: { code, details: [], retryable: false }, meta: {} },
});
const session = (u = user()) =>
  ok({
    accessToken: 'tok',
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    user: u,
    session: { id: 's1' },
  });

function setup(path: string, handler: Handler, config: Partial<AuthConfig> = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const api = createApiClient({
    clientApp: 'CUSTOMER',
    locks: null,
    adapter: async (c: InternalAxiosRequestConfig) => {
      const url = c.url ?? '';
      const body = c.data ? (JSON.parse(c.data as string) as Record<string, unknown>) : {};
      calls.push({ url, body });
      const reply =
        handler(url, body) ??
        (url === '/api/v1/auth/refresh'
          ? fail(401, 'AUTH_REFRESH_INVALID')
          : fail(404, 'NOT_FOUND'));
      const response = {
        data: reply.data,
        status: reply.status,
        statusText: '',
        headers: new AxiosHeaders(),
        config: c,
      };
      if (reply.status >= 400)
        throw new AxiosError('fail', 'ERR_BAD_RESPONSE', c, undefined, response);
      return response;
    },
  });
  const full: AuthConfig = {
    appName: 'Test App',
    methods: ['otp', 'password'],
    allowSignUp: true,
    ...config,
  };
  const location = { current: '' };
  const routes: RouteObject[] = [
    {
      path: '/',
      element: <Outlet />,
      children: [
        ...authRoutes({ allowSignUp: full.allowSignUp }),
        {
          element: <RequireAuth />,
          children: [
            { index: true, element: <p>Home page</p> },
            { path: 'orders', element: <p>Orders page</p> },
          ],
        },
      ],
    },
  ];
  function App() {
    const here = useLocation();
    location.current = `${here.pathname}${here.search}`;
    return useRoutes(routes);
  }
  render(
    <AuthProvider api={api} config={full}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </AuthProvider>,
  );
  return { api, calls, location };
}

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('session restore and guards (FR-FE-001/002)', () => {
  it('sends signed-out visitors to sign-in with a return path, then back after signing in', async () => {
    const { location } = setup('/orders', (url) =>
      url === '/api/v1/auth/login' ? session() : undefined,
    );
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(location.current).toBe('/sign-in?next=%2Forders');
    fireEvent.click(screen.getByRole('tab', { name: 'Password' }));
    type('Email or mobile number', 'asha@example.com');
    type('Password', 'correct horse battery');
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Orders page')).toBeInTheDocument();
  });

  it('restores the session from the refresh cookie without showing sign-in', async () => {
    setup('/', (url) => (url === '/api/v1/auth/refresh' ? session() : undefined));
    expect(await screen.findByText('Home page')).toBeInTheDocument();
  });

  it('routes accounts with an unverified phone to verification first', async () => {
    const { calls } = setup('/', (url) => {
      if (url === '/api/v1/auth/refresh') return session(user({ phoneVerified: false }));
      if (url === '/api/v1/auth/phone/verify') return ok(null);
      if (url === '/api/v1/me') return ok(user());
      return undefined;
    });
    expect(
      await screen.findByRole('heading', { name: 'Verify your mobile number' }),
    ).toBeInTheDocument();
    type('6-digit code', '123456');
    fireEvent.submit(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/v1/auth/phone/verify')?.body).toEqual({
      code: '123456',
    });
  });

  it('shows a retry when the API is unreachable during restore', async () => {
    setup('/', (url) =>
      url === '/api/v1/auth/refresh' ? fail(503, 'SERVICE_UNAVAILABLE') : undefined,
    );
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('only follows same-app return paths', () => {
    expect(safeNext('/orders?x=1', '/')).toBe('/orders?x=1');
    expect(safeNext('//evil.example', '/')).toBe('/');
    expect(safeNext('https://evil.example', '/')).toBe('/');
    expect(safeNext(null, '/home')).toBe('/home');
  });
});

describe('OTP sign-in (FR-AUTH-002)', () => {
  it('validates the number before sending', async () => {
    const { calls } = setup('/sign-in', () => undefined);
    await screen.findByRole('heading', { name: 'Sign in' });
    type('Mobile number', '12345');
    fireEvent.submit(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Enter a valid 10-digit mobile number')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/auth/otp/request')).toBe(false);
  });

  it('creates an account for a new number after collecting name and consent', async () => {
    let loginAttempts = 0;
    const { calls } = setup('/sign-in', (url, body) => {
      if (url === '/api/v1/auth/otp/request')
        return ok({ resendAfterSeconds: 0, expiresInSeconds: 300 });
      if (url === '/api/v1/auth/otp/login') {
        loginAttempts += 1;
        return body.acceptTerms ? session() : fail(422, 'AUTH_TERMS_REQUIRED');
      }
      return undefined;
    });
    await screen.findByRole('heading', { name: 'Sign in' });
    type('Mobile number', '98000 00001');
    fireEvent.submit(screen.getByRole('button', { name: 'Send code' }));
    type(await screen.findByLabelText('6-digit code').then(() => '6-digit code'), '111111');
    fireEvent.submit(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/isn't registered yet/)).toBeInTheDocument();
    type('Full name', 'Asha Rao');
    fireEvent.click(screen.getByLabelText(/I accept the terms/));
    fireEvent.submit(screen.getByRole('button', { name: 'Send new code' }));
    type(await screen.findByLabelText('6-digit code').then(() => '6-digit code'), '222222');
    fireEvent.submit(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(loginAttempts).toBe(2);
    expect(calls.filter((c) => c.url === '/api/v1/auth/otp/request')).toHaveLength(2);
    expect(calls.findLast((c) => c.url === '/api/v1/auth/otp/login')?.body).toEqual({
      phone: '+919800000001',
      code: '222222',
      fullName: 'Asha Rao',
      acceptTerms: true,
    });
  });

  it('shows the API message for a wrong code', async () => {
    setup('/sign-in', (url) => {
      if (url === '/api/v1/auth/otp/request')
        return ok({ resendAfterSeconds: 30, expiresInSeconds: 300 });
      if (url === '/api/v1/auth/otp/login')
        return fail(422, 'AUTH_OTP_INVALID', "That code isn't right.");
      return undefined;
    });
    await screen.findByRole('heading', { name: 'Sign in' });
    type('Mobile number', '9800000001');
    fireEvent.submit(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByLabelText('6-digit code');
    expect(screen.getByRole('button', { name: /Resend code in 30s/ })).toBeDisabled();
    type('6-digit code', '000000');
    fireEvent.submit(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That code isn't right.");
  });
});

describe('admin sign-in (BR-AUTH-018)', () => {
  it('asks for the emailed code before signing in, and offers no sign-up', async () => {
    const { calls } = setup(
      '/sign-in',
      (url) => {
        if (url === '/api/v1/auth/login')
          return ok({ mfaRequired: true, mfaToken: 'm'.repeat(40), mfaTokenExpiresAt: 'x' });
        if (url === '/api/v1/auth/mfa/challenge') return session(user({ roles: ['ADMIN'] }));
        return undefined;
      },
      { methods: ['password'], allowSignUp: false },
    );
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText('Create an account')).toBeNull();
    type('Email or mobile number', 'admin@example.com');
    type('Password', 'correct horse battery');
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    type(await screen.findByLabelText('Sign-in code').then(() => 'Sign-in code'), '654321');
    fireEvent.submit(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/v1/auth/mfa/challenge')?.body).toEqual({
      mfaToken: 'm'.repeat(40),
      code: '654321',
    });
  });
});

describe('sign-up (FR-AUTH-001)', () => {
  it('registers with an E.164 phone and moves to phone verification', async () => {
    const { calls } = setup('/sign-up', (url) =>
      url === '/api/v1/auth/register' ? session(user({ phoneVerified: false })) : undefined,
    );
    await screen.findByRole('heading', { name: 'Create your account' });
    type('Full name', 'Asha Rao');
    type('Email', 'asha@example.com');
    type('Mobile number', '9800000001');
    type('Password', 'a-long-unusual-passphrase');
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/I accept the terms/)).toBeInTheDocument();
    expect(
      await screen.findByText('Please accept the terms and privacy policy'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/I accept the terms/));
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByRole('heading', { name: 'Verify your mobile number' }),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/v1/auth/register')?.body).toMatchObject({
      phone: '+919800000001',
      acceptTerms: true,
    });
  });

  it('puts a breached-password rejection next to the password field', async () => {
    setup('/sign-up', (url) =>
      url === '/api/v1/auth/register'
        ? fail(422, 'AUTH_PASSWORD_BREACHED', 'This password is too common.')
        : undefined,
    );
    await screen.findByRole('heading', { name: 'Create your account' });
    type('Full name', 'Asha Rao');
    type('Email', 'asha@example.com');
    type('Mobile number', '9800000001');
    type('Password', 'password123');
    fireEvent.click(screen.getByLabelText(/I accept the terms/));
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
        'This password is too common.',
      ),
    );
  });
});
