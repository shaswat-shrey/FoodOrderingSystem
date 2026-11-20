import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KdsTicket, MerchantMe, OrderCard } from '@fos/api-client';
import { AuthProvider } from '@fos/auth-web';
import { AppLayout } from '../components/AppLayout';
import { api } from '../lib/api';
import { AUTH_CONFIG } from '../lib/auth';
import { merchant } from '../lib/merchant';
import { HomePage } from './HomePage';
import { KitchenPage } from './KitchenPage';
import { NotFoundPage } from './NotFoundPage';
import { OrdersPage } from './OrdersPage';
import { Hours } from './OutletPage';

const user = {
  id: 'u1',
  fullName: 'Ravi Kumar',
  email: 'ravi@example.com',
  phone: '+919800000001',
  emailVerified: true,
  phoneVerified: true,
  status: 'ACTIVE' as const,
  roles: [],
  scope: 'FULL' as const,
  profileComplete: true,
};
const ALL = [
  'rest.order:read',
  'rest.order:accept',
  'rest.order:prepare',
  'rest.kds:view',
  'rest.menu:read',
  'rest.branch:read',
];
const member = (role = 'MANAGER', permissions = ALL): MerchantMe => ({
  scope: 'FULL',
  restaurants: [
    {
      id: 'r1',
      name: 'Saffron',
      role: role as never,
      permissions,
      branches: [{ id: 'b1', name: 'Koramangala', area: 'Koramangala', status: 'ACTIVE' }],
    },
  ],
  applications: [],
});

function renderAt(path: string, me: MerchantMe) {
  api.authStore.setState({
    status: 'signedIn',
    user,
    accessToken: 't',
    accessTokenExpiresAt: null,
  });
  vi.spyOn(merchant, 'me').mockResolvedValue(me);
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'orders', element: <OrdersPage /> },
          { path: 'kitchen', element: <KitchenPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider api={api} config={AUTH_CONFIG}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return router;
}

const card = (over: Partial<OrderCard> = {}): OrderCard => ({
  id: 'o1',
  number: '261121-ABCDEF',
  status: 'PLACED',
  placedAt: new Date().toISOString(),
  acceptedAt: null,
  readyBy: null,
  prepMinutes: null,
  customer: 'Asha R.',
  area: 'Koramangala',
  payment: 'COD',
  itemCount: 2,
  items: [
    { name: 'Paneer Biryani', variant: null, quantity: 2, options: ['Mild'], instructions: null },
  ],
  cookingInstructions: 'Less oil',
  acceptBy: new Date(Date.now() + 240_000).toISOString(),
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('restaurant app', () => {
  it('sends people without a restaurant to the application form', async () => {
    renderAt('/', { scope: 'ONBOARDING', restaurants: [], applications: [] });
    expect(
      await screen.findByRole('heading', { name: 'List your restaurant' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start application' })).toBeInTheDocument();
  });

  it('opens the order queue for members and accepts a new order with a prep time', async () => {
    vi.spyOn(merchant.orders, 'counts').mockResolvedValue({
      NEW: 1,
      PREPARING: 0,
      READY: 0,
      PICKED_UP: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    });
    vi.spyOn(merchant.orders, 'queue').mockResolvedValue([card()]);
    const accept = vi.spyOn(merchant.orders, 'accept').mockResolvedValue({} as never);
    const router = renderAt('/', member());
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders'));
    const order = await screen.findByRole(
      'article',
      { name: 'Order 261121-ABCDEF' },
      { timeout: 3000 },
    );
    expect(within(order).getByText(/Asha R\./)).toBeInTheDocument();
    expect(within(order).getByText('Cash on delivery')).toBeInTheDocument();
    expect(within(order).getByText(/Less oil/)).toBeInTheDocument();
    // Browsers need a click before playing the alert.
    expect(screen.getByText(/New orders are waiting/)).toBeInTheDocument();
    fireEvent.change(within(order).getByLabelText('Prep time (minutes)'), {
      target: { value: '25' },
    });
    fireEvent.click(within(order).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith('o1', 25));
  });

  it('hides actions the role does not allow', async () => {
    vi.spyOn(merchant.orders, 'counts').mockResolvedValue({
      NEW: 1,
      PREPARING: 0,
      READY: 0,
      PICKED_UP: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    });
    vi.spyOn(merchant.orders, 'queue').mockResolvedValue([card()]);
    renderAt('/orders', member('STAFF', ['rest.order:read']));
    const order = await screen.findByRole('article', { name: 'Order 261121-ABCDEF' });
    expect(within(order).queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Kitchen' })).not.toBeInTheDocument();
  });

  it('shows kitchen tickets by column and keeps them when the connection drops', async () => {
    const ticket: KdsTicket = {
      id: 'o2',
      number: '261121-KDS001',
      status: 'PREPARING',
      acceptedAt: new Date().toISOString(),
      readyBy: null,
      elapsedSeconds: 1500,
      urgency: 'RED',
      items: [
        {
          name: 'Chicken Dum Biryani',
          variant: 'Regular',
          quantity: 1,
          options: [],
          instructions: null,
        },
      ],
      cookingInstructions: null,
    };
    vi.spyOn(merchant.orders, 'kds')
      .mockResolvedValueOnce([ticket])
      .mockRejectedValue(new Error('offline'));
    renderAt('/kitchen', member('KITCHEN'));
    const cooking = await screen.findByRole('region', { name: 'Cooking' });
    expect(await within(cooking).findByText('KDS001')).toBeInTheDocument();
    expect(within(cooking).getByText('25:00')).toBeInTheDocument();
    expect(within(cooking).getByRole('button', { name: 'Ready' })).toBeInTheDocument();
  });

  it('limits opening hours to three slots per day', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <Hours
          branchId="b1"
          initial={[{ weekday: 1, opensAt: '11:00', closesAt: '15:00' }]}
          editable
          onSaved={() => undefined}
        />
      </QueryClientProvider>,
    );
    const monday = screen.getByRole('row', { name: /Mon/ });
    fireEvent.click(within(monday).getByRole('button', { name: 'Add slot' }));
    fireEvent.click(within(monday).getByRole('button', { name: 'Add slot' }));
    expect(within(monday).getAllByLabelText('Mon opens')).toHaveLength(3);
    expect(within(monday).queryByRole('button', { name: 'Add slot' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /Tue/ })).getByText('Closed'),
    ).toBeInTheDocument();
  });
});
