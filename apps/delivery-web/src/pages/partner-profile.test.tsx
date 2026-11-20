import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEnvelope, PartnerApplication } from '@fos/api-client';
import { AuthProvider } from '@fos/auth-web';
import { AppLayout } from '../components/AppLayout';
import { api } from '../lib/api';
import { AUTH_CONFIG } from '../lib/auth';
import { live } from '../lib/live';
import { partner } from '../lib/partner';
import { ProfilePage } from './ProfilePage';

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

const profile = (over: Partial<PartnerApplication> = {}): PartnerApplication => ({
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
      status: 'VERIFIED',
      isActive: true,
    },
    { id: 'v2', type: 'BICYCLE', registrationNumber: null, status: 'VERIFIED', isActive: false },
    {
      id: 'v3',
      type: 'MOTORCYCLE',
      registrationNumber: 'KA02CD5678',
      status: 'PENDING',
      isActive: false,
    },
  ],
  documents: [],
  bank: null,
  guidelines: { required: '1.0', acknowledged: '1.0' },
  missing: [],
  rejectedReason: null,
  ...over,
});

/** Captures live handlers so a test can push an event as the socket would. */
function captureLive() {
  const handlers = new Map<string, Set<(e: LiveEnvelope) => void>>();
  vi.spyOn(live, 'on').mockImplementation((event, h) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(h);
    return () => handlers.get(event)?.delete(h);
  });
  return (event: string, data: Record<string, unknown>) =>
    act(() => {
      for (const h of handlers.get(event) ?? [])
        h({
          eventId: `e-${Math.random()}`,
          event,
          occurredAt: new Date().toISOString(),
          aggregate: { type: 'offer', id: 'o1', version: 0 },
          data,
        });
    });
}

function renderAt(path: string) {
  api.authStore.setState({
    status: 'signedIn',
    user,
    accessToken: 't',
    accessTokenExpiresAt: null,
  });
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <p>Home screen</p> },
          { path: 'account/profile', element: <ProfilePage /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AuthProvider api={api} config={AUTH_CONFIG}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.restoreAllMocks());

describe('live trip notices', () => {
  it('announces a withdrawn offer and a revoked assignment, and can be dismissed', async () => {
    const push = captureLive();
    renderAt('/');
    await screen.findByText('Home screen');
    push('offer.withdrawn', { offerId: 'o1', reason: 'ORDER_CANCELLED' });
    const polite = screen.getByRole('status');
    expect(polite).toHaveAttribute('aria-live', 'polite');
    expect(within(polite).getByText('Offer withdrawn')).toBeInTheDocument();
    expect(within(polite).getByText('The customer’s order was cancelled.')).toBeInTheDocument();

    push('assignment.revoked', { deliveryId: 'd1', reason: 'ORDER_CANCELLED' });
    const urgent = screen.getByRole('alert');
    expect(urgent).toHaveAttribute('aria-live', 'assertive');
    expect(within(urgent).getByText('Delivery taken off you')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Offer withdrawn' }));
    expect(screen.queryByText('Offer withdrawn')).not.toBeInTheDocument();
    expect(screen.getByText('Delivery taken off you')).toBeInTheDocument();
  });
});

describe('partner profile (API-DP-008…012)', () => {
  it('saves the emergency contact and only offers verified vehicles', async () => {
    vi.spyOn(partner.profile, 'get').mockResolvedValue(profile());
    vi.spyOn(partner, 'zones').mockResolvedValue([
      { id: 'z1', name: 'Koramangala', city: 'Bengaluru' },
      { id: 'z2', name: 'HSR Layout', city: 'Bengaluru' },
    ]);
    const update = vi.spyOn(partner.profile, 'update').mockResolvedValue(
      profile({
        emergencyContact: { name: 'Sunil Kumar', relation: 'Brother', phone: '+919811112222' },
      }),
    );
    const activate = vi.spyOn(partner.profile, 'activateVehicle').mockResolvedValue(profile());
    renderAt('/account/profile');
    fireEvent.change(await screen.findByLabelText('Contact name'), {
      target: { value: 'Sunil Kumar' },
    });
    fireEvent.change(screen.getByLabelText('Relation'), { target: { value: 'Brother' } });
    fireEvent.change(screen.getByLabelText('Contact phone'), {
      target: { value: '+919811112222' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        emergencyContact: { name: 'Sunil Kumar', relation: 'Brother', phone: '+919811112222' },
      }),
    );
    expect(await screen.findByText('Emergency contact saved.')).toBeInTheDocument();

    const vehicles = screen.getByRole('list', { name: 'Your vehicles' });
    const rows = within(vehicles).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('In use')).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('button', { name: 'Use this vehicle' })).toBeDisabled();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Use this vehicle' }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith('v2'));
  });
});
