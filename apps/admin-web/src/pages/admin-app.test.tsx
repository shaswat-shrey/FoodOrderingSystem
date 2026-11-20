import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  type AdminDashboard,
  type AdminOrder,
  type AdminPayoutBatch,
  type AdminRestaurantApplication,
  type AdminUser,
  type LiveEnvelope,
  type PermissionsView,
} from '@fos/api-client';
import { AuthProvider } from '@fos/auth-web';
import { AppLayout } from '../components/AppLayout';
import { admin } from '../lib/admin';
import { api } from '../lib/api';
import { AUTH_CONFIG } from '../lib/auth';
import { consoleRoutes } from '../router';
import { NotFoundPage } from './NotFoundPage';

/* A stand-in socket: tests push ops events through `emit`. */
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(env: unknown) => void>>();
  return {
    emit(event: string, env: unknown) {
      for (const h of handlers.get(event) ?? []) h(env);
    },
    live: {
      start() {},
      stop() {},
      status: () => 'connected' as const,
      onStatus: () => () => true,
      on(event: string, handler: (env: unknown) => void) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
        return () => handlers.get(event)?.delete(handler);
      },
      subscribe: () => ({ unsubscribe() {} }),
    },
  };
});
vi.mock('@fos/api-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRealtime: () => socket.live,
}));

const ALL_PERMISSIONS = [
  'dashboard:read',
  'ops:monitor',
  'user:read',
  'pii:reveal',
  'restaurant:review',
  'restaurant:approve',
  'restaurant:read',
  'partner:review',
  'partner:read',
  'order:read:any',
  'order:cancel:any',
  'order:override',
  'order:ops',
  'refund:read',
  'refund:create',
  'dispatch:read',
  'payment:read',
  'payout:read',
  'payout:approve',
  'payout:execute',
  'settings:read',
  'settings:write',
];

const permissions = (perms: string[], roles = ['ADMIN']): PermissionsView => ({
  app: 'ADMIN',
  scope: 'FULL',
  platformRoles: roles,
  permissions: perms,
  restaurants: [],
});

const signedInUser = {
  id: 'admin-1',
  fullName: 'Meera Admin',
  email: 'meera@example.com',
  phone: '+919800000009',
  emailVerified: true,
  phoneVerified: true,
  status: 'ACTIVE' as const,
  roles: ['ADMIN'],
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
        children: [...consoleRoutes, { path: '*', element: <NotFoundPage /> }],
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

const dialog = () => screen.getByRole('dialog');
const typeReason = (text: string) =>
  fireEvent.change(within(dialog()).getByLabelText('Reason'), { target: { value: text } });

const dashboard: AdminDashboard = {
  asOf: '2026-11-21T06:00:00.000Z',
  today: '2026-11-20T18:30:00.000Z',
  users: { total: 1200, newToday: 14 },
  customers: { total: 1100 },
  restaurants: { total: 40, activeNow: 31, pendingApprovals: 3 },
  partners: { total: 90, onlineNow: 22, onDelivery: 9, pendingApprovals: 2 },
  orders: {
    active: { PLACED: 4, ACCEPTED: 2, PREPARING: 6, READY_FOR_PICKUP: 1, PICKED_UP: 5 },
    activeTotal: 18,
    completedToday: 230,
    cancelledToday: 7,
    rejectedToday: 1,
    failedToday: 2,
  },
  gmv: { today: 12_345_600, orders: 230 },
  platformRevenue: { today: 1_850_000, commission: 1_500_000, fees: 350_000 },
  refunds: {
    createdToday: 5,
    createdAmountToday: 210_000,
    succeededAmountToday: 150_000,
    pending: 2,
  },
  payouts: { pendingLines: 12, pendingAmount: 4_500_000, draftBatches: 1 },
  alerts: {
    open: 1,
    bySeverity: { CRITICAL: 1, WARNING: 0, INFO: 0 },
    byType: { NO_PARTNER: 1 },
    unassignedDeliveries: 1,
  },
};

const order = (over: Partial<AdminOrder> = {}): AdminOrder => ({
  id: 'o1',
  number: 'FOS-24001',
  status: 'PREPARING',
  refundStatus: null,
  failureReason: null,
  paymentMethod: 'ONLINE',
  amounts: {
    itemsSubtotal: 80_000,
    discounts: 0,
    fees: 5_000,
    taxes: 4_000,
    tip: 0,
    wallet: 0,
    total: 89_000,
    payable: 89_000,
  },
  priceComponents: [],
  customer: { id: 'u2', name: 'Asha Rao', phone: '+91XXXXXX1234' },
  contact: { name: 'Asha', phone: '+91XXXXXX1234' },
  address: { line1: '12 Lake View', area: 'Koramangala', city: 'Bengaluru', pincode: '560034' },
  restaurant: { id: 'r1', name: 'Saffron' },
  branch: { id: 'b1', name: 'Koramangala', zoneId: 'z1' },
  items: [
    { id: 'i1', name: 'Biryani', variant: null, quantity: 2, lineTotal: 80_000, options: [] },
  ],
  timestamps: {},
  payments: [],
  webhookEvents: [],
  refunds: [],
  cancellation: null,
  issues: [],
  delivery: null,
  statusHistory: [
    { from: null, to: 'PLACED', actorType: 'CUSTOMER', actorId: 'u2', at: '2026-11-21T05:00:00Z' },
  ],
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api.auth, 'permissions').mockResolvedValue(permissions(ALL_PERMISSIONS));
});

describe('admin console', () => {
  it('shows today’s tiles, open alerts with acknowledge, and the live activity feed', async () => {
    vi.spyOn(admin, 'dashboard').mockResolvedValue(dashboard);
    vi.spyOn(admin.alerts, 'list').mockResolvedValue({
      data: [
        {
          id: 'a1',
          type: 'NO_PARTNER',
          severity: 'CRITICAL',
          status: 'OPEN',
          message: 'FOS-24001 has had no partner for 12 minutes',
          ref: { type: 'delivery', id: 'd1' },
          createdAt: '2026-11-21T05:50:00Z',
          acknowledgedAt: null,
          acknowledgedBy: null,
          resolvedAt: null,
        },
      ],
      pagination: { page: 1, pageSize: 20, total: 1, hasMore: false },
    });
    const ack = vi
      .spyOn(admin.alerts, 'acknowledge')
      .mockResolvedValue({ id: 'a1', status: 'ACKNOWLEDGED' });
    renderAt('/');

    expect(await screen.findByText('₹1,23,456')).toBeInTheDocument();
    expect(screen.getByText('Active orders').nextSibling).toHaveTextContent('18');
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(
      await screen.findByText('FOS-24001 has had no partner for 12 minutes'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(ack).toHaveBeenCalledWith('a1', {}));

    const env: LiveEnvelope = {
      eventId: 'e1',
      event: 'ops.order_activity',
      occurredAt: '2026-11-21T06:01:00Z',
      aggregate: { type: 'order', id: 'o1', version: 3 },
      data: { orderId: 'o1', number: 'FOS-24001', status: 'PICKED_UP' },
    };
    act(() => socket.emit('ops.order_activity', env));
    expect(
      await screen.findByRole('link', { name: 'Order FOS-24001 → Picked up' }),
    ).toHaveAttribute('href', '/orders/o1');
  });

  it('approves a restaurant application only once a reason is given', async () => {
    vi.spyOn(admin.restaurantApplications, 'get').mockResolvedValue({
      id: 'r1',
      status: 'UNDER_REVIEW',
      editable: false,
      submissionCount: 1,
      brandName: 'Saffron',
      legalName: 'Saffron Foods Pvt Ltd',
      entityType: 'PRIVATE_LIMITED',
      panMasked: 'XXXXXX234F',
      gstin: null,
      fssaiNumber: '12345678901234',
      fssaiExpiresOn: '2027-03-31',
      description: null,
      contactEmail: 'hi@saffron.example',
      contactPhone: '+919811111111',
      pureVeg: false,
      cuisines: [{ id: 'c1', name: 'Biryani' }],
      logo: null,
      branch: null,
      bank: null,
      documents: [
        { id: 'doc1', type: 'FSSAI', fileId: 'f1', status: 'PENDING', reviewerNote: null },
      ],
      missing: [],
      review: null,
      rejectedReason: null,
      owner: { id: 'u5', fullName: 'Ravi Shah' },
      reviews: [],
      flags: [],
      createdAt: '2026-11-19T05:00:00Z',
      updatedAt: '2026-11-20T05:00:00Z',
    } satisfies AdminRestaurantApplication);
    const approve = vi
      .spyOn(admin.restaurantApplications, 'approve')
      .mockResolvedValue({} as AdminRestaurantApplication);
    renderAt('/approvals/restaurants/r1');

    expect(await screen.findByRole('heading', { name: 'Saffron' })).toBeInTheDocument();
    expect(screen.getByText('Every required item is complete.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const confirm = within(dialog()).getByRole('button', { name: 'Approve' });
    expect(confirm).toBeDisabled();
    typeReason('ok');
    expect(confirm).toBeDisabled();
    typeReason('FSSAI and PAN verified against originals');
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith('r1', 'FSSAI and PAN verified against originals'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('reveals a user’s masked contact details with a reason', async () => {
    vi.spyOn(admin.users, 'get').mockResolvedValue({
      id: 'u2',
      fullName: 'Asha Rao',
      phone: '+91XXXXXX1234',
      email: 'a***@example.com',
      status: 'ACTIVE',
      roles: ['CUSTOMER'],
      createdAt: '2026-01-01T00:00:00Z',
      phoneVerified: true,
      emailVerified: true,
      suspension: null,
      flags: { codBlocked: false, codRefusalCount: 0 },
      wallet: { availableAmount: 5_000, heldAmount: 0 },
      orders: { total: 12, delivered: 11 },
      activeSessions: 2,
      partner: null,
      restaurants: [],
      deletionScheduledAt: null,
    } satisfies AdminUser);
    const reveal = vi
      .spyOn(admin.users, 'revealPii')
      .mockResolvedValue({ id: 'u2', phone: '+919876541234', email: 'asha.rao@example.com' });
    renderAt('/users/u2');

    expect(await screen.findByText(/\+91XXXXXX1234/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    typeReason('Customer called about a missing refund');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText(/\+919876541234/)).toBeInTheDocument();
    expect(screen.getByText(/asha\.rao@example\.com/)).toBeInTheDocument();
    expect(reveal).toHaveBeenCalledWith('u2', 'Customer called about a missing refund');
    expect(screen.queryByRole('button', { name: 'Reveal' })).not.toBeInTheDocument();
  });

  it('cancels an order with a fault, showing the server’s refusal first', async () => {
    vi.spyOn(admin.orders, 'get').mockResolvedValue(order());
    vi.spyOn(admin.orders, 'audit').mockResolvedValue({
      orderId: 'o1',
      number: 'FOS-24001',
      audit: [],
      statusHistory: [],
      deliveryHistory: [],
    });
    const cancel = vi
      .spyOn(admin.orders, 'cancel')
      .mockRejectedValueOnce(
        new ApiClientError('ORDER_STATE_CONFLICT', 'This order was picked up a moment ago.', 409),
      )
      .mockResolvedValue({});
    renderAt('/orders/o1');

    expect(await screen.findByRole('heading', { name: 'Order FOS-24001' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    const d = dialog();
    fireEvent.change(within(d).getByLabelText('Reason code'), {
      target: { value: 'restaurant_closed' },
    });
    fireEvent.change(within(d).getByLabelText('Fault'), { target: { value: 'RESTAURANT' } });
    typeReason('Restaurant phoned to say they closed early');
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel order' }));
    expect(
      await within(d).findByText('This order was picked up a moment ago.'),
    ).toBeInTheDocument();

    fireEvent.click(within(d).getByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByText('Order cancelled.')).toBeInTheDocument();
    expect(cancel).toHaveBeenLastCalledWith('o1', {
      reasonCode: 'RESTAURANT_CLOSED',
      fault: 'RESTAURANT',
      reason: 'Restaurant phoned to say they closed early',
    });
  });

  it('sends a refund above the support limit for approval', async () => {
    vi.spyOn(api.auth, 'permissions').mockResolvedValue(
      permissions(['order:read:any', 'refund:create', 'refund:read'], ['SUPPORT_AGENT']),
    );
    vi.spyOn(admin.orders, 'get').mockResolvedValue(order({ status: 'DELIVERED' }));
    const refund = vi
      .spyOn(admin.orders, 'refund')
      .mockRejectedValueOnce(
        new ApiClientError('REFUND_LIMIT_EXCEEDED', 'This refund is above your limit.', 422, [
          { path: 'amount', code: 'LIMIT', message: '50000' },
          { path: 'amount', code: 'REMAINING', message: '50000' },
        ]),
      )
      .mockResolvedValue({
        refund: {
          id: 'rf1',
          orderId: 'o1',
          paymentId: null,
          amount: 80_000,
          destination: 'SOURCE',
          status: 'REQUESTED',
          reasonCode: 'WRONG_ORDER',
          note: 'Entire order was wrong',
          initiatorType: 'ADMIN',
          costBearer: 'RESTAURANT',
          attempts: 0,
          createdAt: '2026-11-21T06:00:00Z',
          completedAt: null,
        },
      });
    renderAt('/orders/o1');

    fireEvent.click(await screen.findByRole('button', { name: 'Issue refund' }));
    const d = dialog();
    fireEvent.change(within(d).getByLabelText('Amount (₹)'), { target: { value: '800' } });
    fireEvent.change(within(d).getByLabelText('Reason code'), { target: { value: 'WRONG_ORDER' } });
    fireEvent.change(within(d).getByLabelText('Who bears the cost'), {
      target: { value: 'RESTAURANT' },
    });
    typeReason('Entire order was wrong');
    fireEvent.click(within(d).getByRole('button', { name: 'Refund' }));
    expect(await within(d).findByText('Above your refund limit')).toBeInTheDocument();
    expect(within(d).getByText(/Your limit is ₹500 per order/)).toBeInTheDocument();

    fireEvent.click(within(d).getByLabelText(/Send for supervisor approval/));
    fireEvent.click(within(d).getByRole('button', { name: 'Request approval' }));
    expect(await screen.findByText('Refund of ₹800 sent for approval.')).toBeInTheDocument();
    expect(refund).toHaveBeenLastCalledWith('o1', {
      amount: 80_000,
      destination: 'SOURCE',
      reasonCode: 'WRONG_ORDER',
      note: 'Entire order was wrong',
      costBearer: 'RESTAURANT',
      requestApproval: true,
    });
  });

  it('marks a payout line paid with its bank reference', async () => {
    const batch: AdminPayoutBatch = {
      id: 'b1',
      type: 'RESTAURANT',
      periodStart: '2026-11-09T18:30:00Z',
      periodEnd: '2026-11-16T18:30:00Z',
      status: 'APPROVED',
      createdBy: 'admin-2',
      approvedBy: 'admin-1',
      approvedAt: '2026-11-17T05:00:00Z',
      createdAt: '2026-11-17T04:00:00Z',
      totals: {
        lines: 1,
        amount: 2_500_000,
        pending: { lines: 1, amount: 2_500_000 },
        paid: { lines: 0, amount: 0 },
        failed: { lines: 0, amount: 0 },
      },
      lines: [
        {
          id: 'l1',
          payeeType: 'RESTAURANT',
          payee: { id: 'r1', name: 'Saffron Foods Pvt Ltd' },
          bank: { holderName: 'Saffron Foods', accountMasked: 'XXXXXX4321', ifsc: 'HDFC0XXXXXX' },
          amount: 2_500_000,
          cashDeduction: 0,
          status: 'PENDING',
          utr: null,
          failureReason: null,
          paidAt: null,
        },
      ],
    };
    vi.spyOn(admin.payouts, 'get').mockResolvedValue(batch);
    const markPaid = vi.spyOn(admin.payouts, 'markPaid').mockResolvedValue(batch);
    renderAt('/payouts/b1');

    expect(await screen.findByText('Saffron Foods Pvt Ltd')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    const confirm = within(dialog()).getByRole('button', { name: 'Mark paid' });
    typeReason('Paid by NEFT batch 17 Nov');
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog()).getByLabelText('Bank reference (UTR)'), {
      target: { value: 'HDFCN52026111700001' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(markPaid).toHaveBeenCalledWith('b1', 'l1', {
        utr: 'HDFCN52026111700001',
        reason: 'Paid by NEFT batch 17 Nov',
      }),
    );
  });

  it('edits a setting inline with a reason', async () => {
    vi.spyOn(admin.settings, 'list').mockResolvedValue([
      {
        key: 'support.refundLimit',
        description: 'Largest refund a support agent can issue per order (paise)',
        critical: false,
        default: 50_000,
        value: 50_000,
        storedValueInvalid: false,
        updatedAt: null,
        updatedBy: null,
      },
    ]);
    const update = vi.spyOn(admin.settings, 'update').mockResolvedValue({} as never);
    renderAt('/settings');

    fireEvent.click(await screen.findByRole('button', { name: 'Edit support.refundLimit' }));
    const editor = screen.getByLabelText('Value of support.refundLimit (JSON)');
    fireEvent.change(editor, { target: { value: '{ broken' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(editor, { target: { value: '75000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    typeReason('Raised after the Q4 support review');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save setting' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'support.refundLimit',
        75_000,
        'Raised after the Q4 support review',
      ),
    );
  });

  it('only lists sections the admin may use, and explains a 403', async () => {
    vi.spyOn(api.auth, 'permissions').mockResolvedValue(
      permissions(['dashboard:read', 'order:read:any', 'support:read'], ['SUPPORT_AGENT']),
    );
    vi.spyOn(admin.payouts, 'list').mockRejectedValue(
      new ApiClientError('FORBIDDEN', 'You don’t have permission to do this.', 403),
    );
    renderAt('/payouts');

    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(await within(nav).findByRole('link', { name: 'Orders' })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(nav).queryByRole('link', { name: 'Payouts' })).not.toBeInTheDocument(),
    );
    expect(within(nav).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Support desk' })).toBeInTheDocument();
    expect(await screen.findByText("You don't have access")).toBeInTheDocument();
  });

  it('renders a 404 page for unknown routes', () => {
    renderAt('/no-such-page');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });
});
