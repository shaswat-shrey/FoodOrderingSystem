import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  type ActiveDelivery,
  type Availability,
  type PartnerApplication,
} from '@fos/api-client';
import { AuthProvider } from '@fos/auth-web';
import { AppLayout } from '../components/AppLayout';
import { api } from '../lib/api';
import { AUTH_CONFIG } from '../lib/auth';
import { partner } from '../lib/partner';
import { DeliveryPage } from './DeliveryPage';
import { EarningsPage } from './EarningsPage';
import { HomePage } from './HomePage';
import { NotFoundPage } from './NotFoundPage';

vi.mock('../lib/location', () => ({
  currentFix: vi.fn(async () => ({ lat: 12.93, lng: 77.62, accuracyM: 8 })),
  useLocationReporting: vi.fn(),
}));

const user = {
  id: 'u1',
  fullName: 'Ravi Kumar',
  email: null,
  phone: '+919800000001',
  emailVerified: false,
  phoneVerified: true,
  status: 'ACTIVE' as const,
  roles: [],
  scope: 'FULL' as const,
  profileComplete: true,
};

const application = (over: Partial<PartnerApplication> = {}): PartnerApplication => ({
  id: 'p1',
  status: 'APPROVED',
  accountStatus: 'ACTIVE',
  editable: false,
  legalName: 'Ravi Kumar',
  dateOfBirth: '1996-04-12',
  homeZone: { id: 'z1', name: 'Koramangala' },
  photoFileId: 'f1',
  panMasked: 'XXXXXX234L',
  aadhaarMasked: 'XXXX XXXX 4321',
  emergencyContact: null,
  vehicles: [
    {
      id: 'v1',
      type: 'SCOOTER',
      registrationNumber: 'KA01AB1234',
      status: 'APPROVED',
      isActive: true,
    },
  ],
  documents: [],
  bank: null,
  guidelines: { required: '1.0', acknowledged: '1.0' },
  missing: [],
  rejectedReason: null,
  ...over,
});

const availability = (over: Partial<Availability> = {}): Availability => ({
  state: 'OFFLINE',
  offlineAfterCurrent: false,
  pausedUntil: null,
  activeDeliveryId: null,
  cashInHand: 0,
  cashCap: 300_000,
  blockers: [],
  ...over,
});

const delivery = (over: Partial<ActiveDelivery> = {}): ActiveDelivery => ({
  id: 'd1',
  status: 'AT_CUSTOMER',
  orderNumber: 'FOS-12345',
  orderStatus: 'PICKED_UP',
  pickupCode: '4821',
  restaurant: {
    name: 'Saffron',
    branch: 'Koramangala',
    address: '1 Main Rd',
    phone: null,
    location: null,
  },
  items: 2,
  customer: {
    name: 'Asha',
    address: '12 Lake View',
    instructions: 'Ring twice',
    location: { lat: 12.94, lng: 77.63 },
  },
  payment: { type: 'COD', collect: 45_000 },
  proof: 'OTP',
  distances: { pickupM: 800, dropM: 2400 },
  earning: null,
  times: { assignedAt: null, arrivedRestaurantAt: null, pickedUpAt: null, deliveredAt: null },
  ...over,
});

function renderAt(path: string) {
  api.authStore.setState({
    status: 'signedIn',
    user,
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
          { path: 'delivery', element: <DeliveryPage /> },
          { path: 'earnings', element: <EarningsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider api={api} config={AUTH_CONFIG}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(partner, 'dashboard').mockResolvedValue({
    onlineSeconds: 3_900,
    deliveries: 3,
    earnings: 18_500,
    tips: 2_000,
    activeDeliveryId: null,
    availability: availability(),
  });
});

describe('delivery partner app', () => {
  it('invites a new partner to apply, then lists what is still missing', async () => {
    vi.spyOn(partner.application, 'get').mockRejectedValueOnce(
      new ApiClientError('NOT_FOUND', 'Not found', 404),
    );
    const start = vi.spyOn(partner.application, 'start').mockResolvedValue(
      application({
        status: 'DRAFT',
        editable: true,
        missing: [{ path: 'bank', code: 'MISSING', message: 'Bank account' }],
      }),
    );
    vi.spyOn(partner, 'zones').mockResolvedValue([
      { id: 'z1', name: 'Koramangala', city: 'Bengaluru' },
    ]);
    renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Start my application' }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(await screen.findByText('Bank account')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit application' })).toBeDisabled();
  });

  it('goes online with a location fix and accepts an offer', async () => {
    vi.spyOn(partner.application, 'get').mockResolvedValue(application());
    const avail = vi.spyOn(partner, 'availability').mockResolvedValue(availability());
    const goOnline = vi
      .spyOn(partner, 'goOnline')
      .mockResolvedValue(availability({ state: 'ONLINE_IDLE' }));
    vi.spyOn(partner.offers, 'current').mockResolvedValue({
      offerId: 'o1',
      deliveryId: 'd1',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      serverTime: new Date().toISOString(),
      restaurant: { name: 'Saffron', branch: 'Koramangala', area: 'Koramangala', distanceKm: 0.6 },
      drop: { area: 'HSR Layout', distanceKm: 3.1 },
      items: 2,
      payment: { type: 'COD', collect: 45_000 },
    });
    const accept = vi
      .spyOn(partner.offers, 'accept')
      .mockResolvedValue({ deliveryId: 'd1', status: 'ASSIGNED' });
    vi.spyOn(partner.deliveries, 'active').mockResolvedValue(delivery({ status: 'ASSIGNED' }));
    const router = renderAt('/');
    expect(await screen.findByText('₹185')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Go online' }));
    await waitFor(() =>
      expect(goOnline).toHaveBeenCalledWith({ lat: 12.93, lng: 77.62, accuracyM: 8 }),
    );
    avail.mockResolvedValue(availability({ state: 'ONLINE_IDLE' }));
    const card = await screen.findByRole('region', { name: 'New order offer' });
    expect(card).toHaveTextContent('Collect cash ₹450');
    expect(card).toHaveTextContent('HSR Layout · 3.1 km trip');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith('o1'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/delivery'));
  });

  it('asks for confirmation outside the geofence (BR-DEL-013)', async () => {
    vi.spyOn(partner.deliveries, 'active').mockResolvedValue(delivery({ status: 'ASSIGNED' }));
    const arrive = vi
      .spyOn(partner.deliveries, 'arrivedAtRestaurant')
      .mockRejectedValueOnce(new ApiClientError('GEOFENCE_CONFIRMATION_REQUIRED', 'Too far', 422))
      .mockResolvedValueOnce(delivery({ status: 'AT_RESTAURANT' }));
    renderAt('/delivery');
    expect(await screen.findByLabelText('Pickup code')).toHaveTextContent('4821');
    fireEvent.click(screen.getByRole('button', { name: 'Arrived at the restaurant' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, I’m here' }));
    await waitFor(() =>
      expect(arrive).toHaveBeenLastCalledWith('d1', {
        at: { lat: 12.93, lng: 77.62 },
        confirm: true,
      }),
    );
    expect(await screen.findByRole('button', { name: 'Picked up the order' })).toBeInTheDocument();
  });

  it('completes a cash order only with the code and the cash confirmed', async () => {
    vi.spyOn(partner.deliveries, 'active').mockResolvedValue(delivery());
    const complete = vi
      .spyOn(partner.deliveries, 'complete')
      .mockResolvedValue(delivery({ status: 'DELIVERED', earning: { total: 6_100, tip: 2_000 } }));
    renderAt('/delivery');
    const button = await screen.findByRole('button', { name: 'Complete delivery' });
    fireEvent.change(screen.getByLabelText('Delivery code from the customer'), {
      target: { value: '12a34' },
    });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I collected ₹450 in cash'));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith('d1', {
        method: 'OTP',
        otp: '1234',
        at: { lat: 12.93, lng: 77.62 },
        cashCollected: true,
      }),
    );
    expect(await screen.findByText(/You earned ₹61, including a ₹20 tip/)).toBeInTheDocument();
  });

  it('shows earnings, cash and why the next payout is held', async () => {
    vi.spyOn(partner.earnings, 'summary').mockResolvedValue({
      period: 'day',
      from: '',
      to: '',
      deliveries: 3,
      cancelledTrips: 0,
      distanceKm: 7.4,
      breakdown: {
        base: 7_500,
        distance: 3_000,
        wait: 0,
        surge: 0,
        tips: 2_000,
        incentives: 0,
        adjustments: 0,
      },
      tripPay: 10_500,
      total: 12_500,
      days: [],
    });
    vi.spyOn(partner.earnings, 'cash').mockResolvedValue({
      balance: 90_000,
      cap: 300_000,
      remaining: 210_000,
      blocked: false,
      howToDeposit: 'Deposit at a hub.',
    });
    vi.spyOn(partner.earnings, 'payouts').mockResolvedValue({
      next: {
        periodStart: '',
        periodEnd: '',
        earnings: 12_500,
        cashDeduction: 90_000,
        amount: -77_500,
        minimum: 10_000,
        status: 'CARRY_OVER_NEGATIVE',
      },
      items: [],
    });
    vi.spyOn(partner.earnings, 'performance').mockResolvedValue({
      windowDays: 30,
      offers: 4,
      acceptanceRate: 75,
      deliveries: 3,
      completionRate: 100,
      onTimeRate: 100,
      rating: null,
      ratingCount: 0,
    });
    vi.spyOn(partner.earnings, 'ratings').mockResolvedValue({
      average: 4.8,
      count: 6,
      distribution: {},
      tags: { ON_TIME: 4 },
      comments: [],
    });
    vi.spyOn(partner.earnings, 'entries').mockResolvedValue({ data: [], nextCursor: null });
    renderAt('/earnings');
    expect(await screen.findByText('₹125')).toBeInTheDocument();
    expect(await screen.findByText('₹900')).toBeInTheDocument();
    expect(screen.getByText(/You hold more cash than you earned/)).toBeInTheDocument();
    expect(screen.getByText('4.8 ★')).toBeInTheDocument();
    expect(screen.getByText('on time · 4')).toBeInTheDocument();
  });

  it('renders a 404 page for unknown routes', () => {
    renderAt('/no-such-page');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });
});
