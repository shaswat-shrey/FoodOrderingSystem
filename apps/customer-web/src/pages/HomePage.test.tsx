import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@fos/auth-web';
import { AppLayout } from '../components/AppLayout';
import { api } from '../lib/api';
import { AUTH_CONFIG } from '../lib/auth';
import { HomePage } from './HomePage';
import { NotFoundPage } from './NotFoundPage';

const signedInUser = {
  id: 'u1',
  fullName: 'Asha Rao',
  email: 'asha@example.com',
  phone: '+919800000001',
  emailVerified: true,
  phoneVerified: true,
  status: 'ACTIVE' as const,
  roles: [],
  scope: 'FULL' as const,
  profileComplete: true,
};

function renderAt(path: string) {
  api.authStore.setState({
    status: 'signedIn',
    user: signedInUser,
    accessToken: 't',
    accessTokenExpiresAt: null,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider api={api} config={AUTH_CONFIG}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('customer-web shell', () => {
  it('shows the app, marks features as awaiting implementation, and reports live status', async () => {
    vi.spyOn(api, 'readiness').mockResolvedValue({
      status: 'degraded',
      checks: { database: { status: 'up' }, redisCore: { status: 'down', error: 'unreachable' } },
    });
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1, name: 'FoodOrderSystem' })).toBeInTheDocument();
    expect(screen.getByText(/Awaiting implementation/)).toBeInTheDocument();
    expect(await screen.findByText('Running with reduced capacity')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Asha Rao' })).toHaveAttribute(
      'href',
      '/account/security',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('offers a retry when the API cannot be reached', async () => {
    vi.spyOn(api, 'readiness').mockRejectedValue(new Error('offline'));
    renderAt('/');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders a 404 page for unknown routes', () => {
    vi.spyOn(api, 'readiness').mockResolvedValue({ status: 'ok', checks: {} });
    renderAt('/no-such-page');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });
});
