import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  type BranchReview,
  type ManagedMenu,
  type MenuItem,
  type MerchantMe,
  type OrderDetails,
  type QueueTab,
} from '@fos/api-client';
import { AuthProvider } from '@fos/auth-web';
import { AppLayout } from '../components/AppLayout';
import { api } from '../lib/api';
import { AUTH_CONFIG } from '../lib/auth';
import { merchant } from '../lib/merchant';
import { AnalyticsPage } from './AnalyticsPage';
import { DishEditorPage } from './DishEditorPage';
import { OptionGroupsPage } from './OptionGroupsPage';
import { OrdersPage } from './OrdersPage';
import { Holidays } from './OutletPage';
import { PayoutsPage } from './PayoutsPage';
import { ReviewsPage } from './ReviewsPage';

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
const OWNER = [
  'rest.restaurant:read',
  'rest.restaurant:legal',
  'rest.order:read',
  'rest.order:accept',
  'rest.order:prepare',
  'rest.order:handover',
  'rest.menu:read',
  'rest.menu:write',
  'rest.branch:read',
  'rest.analytics:read',
  'rest.review:read',
  'rest.review:respond',
  'rest.finance:read',
];
const me: MerchantMe = {
  scope: 'FULL',
  restaurants: [
    {
      id: 'r1',
      name: 'Saffron',
      role: 'OWNER',
      permissions: OWNER,
      branches: [{ id: 'b1', name: 'Koramangala', area: 'Koramangala', status: 'ACTIVE' }],
    },
  ],
  applications: [],
};

function renderAt(path: string) {
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
          { path: 'orders', element: <OrdersPage /> },
          { path: 'menu/items/:itemId', element: <DishEditorPage /> },
          { path: 'menu/groups', element: <OptionGroupsPage /> },
          { path: 'analytics', element: <AnalyticsPage /> },
          { path: 'reviews', element: <ReviewsPage /> },
          { path: 'payouts', element: <PayoutsPage /> },
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

const dish = (over: Partial<MenuItem> = {}): MenuItem => ({
  id: 'i1',
  categoryId: 'c1',
  name: 'Chicken Biryani',
  description: 'Slow-cooked',
  basePriceAmount: 32_000,
  discountedPriceAmount: null,
  dietaryMarker: 'NON_VEG',
  spiceLevel: 2,
  servingSize: null,
  prepMinutes: 20,
  calories: null,
  isHidden: false,
  isBestseller: true,
  isRecommended: false,
  isTodaysSpecial: false,
  isFeatured: false,
  packagingFeeAmount: null,
  tags: ['SPICY'],
  allergens: [],
  ingredients: ['Rice', 'Chicken'],
  images: [],
  variants: [
    { id: 'v1', name: 'Half', priceAmount: 22_000, isDefault: true },
    { id: 'v2', name: 'Full', priceAmount: 32_000, isDefault: false },
  ],
  customizationGroups: [],
  version: 3,
  ...over,
});
const menu = (groups: ManagedMenu['customizationGroups'] = []): ManagedMenu => ({
  categories: [
    { id: 'c1', name: 'Biryani', description: null, isActive: true, items: [dish()] },
    { id: 'c2', name: 'Sides', description: null, isActive: true, items: [] },
  ],
  customizationGroups: groups,
});

afterEach(() => vi.restoreAllMocks());

describe('dish editor (API-RMENU)', () => {
  it('keeps exactly one default variant and changes it on request', async () => {
    vi.spyOn(merchant.menu, 'item').mockResolvedValue(dish());
    vi.spyOn(merchant.menu, 'get').mockResolvedValue(menu());
    const update = vi.spyOn(merchant.menu, 'updateVariant').mockResolvedValue(
      dish({
        version: 4,
        variants: [
          { id: 'v1', name: 'Half', priceAmount: 22_000, isDefault: false },
          { id: 'v2', name: 'Full', priceAmount: 32_000, isDefault: true },
        ],
      }),
    );
    renderAt('/menu/items/i1');
    const half = await screen.findByRole('listitem', { name: 'Variant Half' });
    const full = screen.getByRole('listitem', { name: 'Variant Full' });
    // The default can't be switched off; only another variant can take over.
    expect(within(half).getByText('Default')).toBeInTheDocument();
    expect(within(half).queryByRole('button', { name: 'Make default' })).not.toBeInTheDocument();
    fireEvent.click(within(full).getByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('r1', 'i1', 'v2', { isDefault: true }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('listitem', { name: 'Variant Full' })).getByText('Default'),
      ).toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('listitem', { name: 'Variant Half' })).getByRole('button', {
        name: 'Make default',
      }),
    ).toBeInTheDocument();
  });

  it('saves with the version it loaded and explains a conflict', async () => {
    const item = vi
      .spyOn(merchant.menu, 'item')
      .mockResolvedValueOnce(dish())
      .mockResolvedValue(dish({ name: 'Chicken Dum Biryani', version: 5 }));
    vi.spyOn(merchant.menu, 'get').mockResolvedValue(menu());
    const save = vi
      .spyOn(merchant.menu, 'updateItem')
      .mockRejectedValue(
        new ApiClientError('CONFLICT_STALE_VERSION', 'Someone else changed this dish.', 409),
      );
    renderAt('/menu/items/i1');
    const price = await screen.findByLabelText(/^Offer price/);
    // An offer above the price is caught before sending.
    fireEvent.change(price, { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dish' }));
    expect(
      await screen.findByText('The offer price must be lower than the price.'),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(price, { target: { value: '299' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dish' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'r1',
        'i1',
        expect.objectContaining({ basePriceAmount: 32_000, discountedPriceAmount: 29_900 }),
        3,
      ),
    );
    expect(await screen.findByText('This dish was changed elsewhere')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload dish' }));
    await waitFor(() => expect(item).toHaveBeenCalledTimes(2));
    expect(await screen.findByDisplayValue('Chicken Dum Biryani')).toBeInTheDocument();
    expect(screen.queryByText('This dish was changed elsewhere')).not.toBeInTheDocument();
  });
});

describe('option groups (BR-MENU-003)', () => {
  it('checks minimum and maximum before saving', async () => {
    vi.spyOn(merchant.menu, 'get').mockResolvedValue(
      menu([
        {
          id: 'g1',
          name: 'Extras',
          minSelect: 0,
          maxSelect: 2,
          attachedTo: 1,
          options: [
            { id: 'o1', name: 'Raita', priceDeltaAmount: 3_000, dietaryMarker: 'VEG' },
            { id: 'o2', name: 'Salan', priceDeltaAmount: 4_000, dietaryMarker: 'VEG' },
          ],
        },
      ]),
    );
    const create = vi.spyOn(merchant.menu, 'createGroup').mockResolvedValue({} as never);
    const update = vi.spyOn(merchant.menu, 'updateGroup').mockResolvedValue({} as never);
    renderAt('/menu/groups');
    const group = await screen.findByRole('region', { name: 'Option group Extras' });
    fireEvent.change(within(group).getByLabelText('Maximum choices'), { target: { value: '3' } });
    expect(within(group).getByRole('alert')).toHaveTextContent(
      'The maximum can’t be more than the number of options (2).',
    );
    expect(within(group).getByRole('button', { name: 'Save rules' })).toBeDisabled();
    fireEvent.change(within(group).getByLabelText('Minimum choices'), { target: { value: '2' } });
    fireEvent.change(within(group).getByLabelText('Maximum choices'), { target: { value: '1' } });
    expect(within(group).getByRole('alert')).toHaveTextContent(
      'The minimum can’t be more than the maximum.',
    );
    fireEvent.change(within(group).getByLabelText('Maximum choices'), { target: { value: '2' } });
    fireEvent.click(within(group).getByRole('button', { name: 'Save rules' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('r1', 'g1', {
        name: 'Extras',
        minSelect: 2,
        maxSelect: 2,
      }),
    );
    // A group in use can't be deleted.
    expect(within(group).getByRole('button', { name: 'Delete group' })).toBeDisabled();

    const form = screen.getByRole('region', { name: 'New option group' });
    fireEvent.change(within(form).getByLabelText('Group name'), { target: { value: 'Spice' } });
    fireEvent.change(within(form).getByLabelText('Maximum choices'), { target: { value: '0' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create group' }));
    expect(await within(form).findByText('The maximum must be at least 1.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('outlet closures (FR-REST-016)', () => {
  it('adds a holiday in outlet time and refuses an end before the start', async () => {
    const add = vi.spyOn(merchant.branch, 'addHoliday').mockResolvedValue({} as never);
    const onSaved = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Holidays branchId="b1" holidays={[]} editable onSaved={onSaved} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('No closures planned.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Closed from'), {
      target: { value: '2026-12-25T10:00' },
    });
    fireEvent.change(screen.getByLabelText('Closed until'), {
      target: { value: '2026-12-25T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add closure' }));
    expect(await screen.findByText('The closure must end after it starts.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Closed until'), {
      target: { value: '2026-12-26T09:00' },
    });
    fireEvent.change(screen.getByLabelText('Reason (optional)'), {
      target: { value: 'Christmas' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add closure' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('b1', {
        startsAt: '2026-12-25T04:30:00.000Z',
        endsAt: '2026-12-26T03:30:00.000Z',
        reason: 'Christmas',
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe('order details and handover (FR-RORD-007)', () => {
  it('hands over with the partner’s pickup code and shows a wrong code', async () => {
    const counts: Record<QueueTab, number> = {
      NEW: 0,
      PREPARING: 1,
      READY: 0,
      PICKED_UP: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };
    const card = {
      id: 'o1',
      number: '261121-ABCDEF',
      status: 'READY_FOR_PICKUP',
      placedAt: new Date().toISOString(),
      acceptedAt: new Date().toISOString(),
      readyBy: null,
      prepMinutes: 20,
      customer: 'Asha R.',
      area: 'Koramangala',
      payment: 'PAID' as const,
      itemCount: 1,
      items: [
        { name: 'Paneer Biryani', variant: null, quantity: 1, options: [], instructions: null },
      ],
      cookingInstructions: null,
      acceptBy: null,
    };
    const details: OrderDetails = {
      ...card,
      version: 4,
      value: null,
      timeline: [{ status: 'READY_FOR_PICKUP', at: new Date().toISOString(), by: 'RESTAURANT' }],
      partner: {
        firstName: 'Imran',
        vehicleType: 'MOTORCYCLE',
        deliveryStatus: 'AT_RESTAURANT',
        assignedAt: new Date().toISOString(),
        arrivedAt: new Date().toISOString(),
        pickedUpAt: null,
      },
    };
    vi.spyOn(merchant.orders, 'counts').mockResolvedValue(counts);
    vi.spyOn(merchant.orders, 'queue').mockResolvedValue([card]);
    vi.spyOn(merchant.orders, 'get').mockResolvedValue(details);
    const handover = vi
      .spyOn(merchant.orders, 'handover')
      .mockRejectedValueOnce(
        new ApiClientError('PICKUP_CODE_INVALID', 'That pickup code is not correct.', 422),
      )
      .mockResolvedValueOnce({ orderId: 'o1', status: 'PICKED_UP', partner: 'Imran' });
    renderAt('/orders');
    const order = await screen.findByRole('article', { name: 'Order 261121-ABCDEF' });
    fireEvent.click(within(order).getByRole('button', { name: 'Details and handover' }));
    const drawer = await screen.findByRole('dialog', { name: 'Order 261121-ABCDEF' });
    expect(within(drawer).getByText(/Imran has arrived/)).toBeInTheDocument();
    const code = within(drawer).getByLabelText(/pickup code/);
    fireEvent.change(code, { target: { value: '12a3' } });
    expect(within(drawer).getByRole('button', { name: 'Hand over order' })).toBeDisabled();
    fireEvent.change(code, { target: { value: '1234' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Hand over order' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent(
      'That pickup code is not correct.',
    );
    expect(handover).toHaveBeenCalledWith('o1', '1234');
    fireEvent.change(code, { target: { value: '4821' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Hand over order' }));
    expect(await within(drawer).findByText('Handed over to Imran.')).toBeInTheDocument();
  });
});

describe('analytics (FR-RANL-002…004)', () => {
  it('draws one bar per period and lists top dishes from the data', async () => {
    const point = (bucket: string, revenue: number) => ({
      bucket,
      orders: 5,
      delivered: 4,
      revenue,
      averageOrderValue: revenue / 4,
      cancellationRate: 0,
      rejectionRate: 0,
      newCustomers: 2,
      repeatCustomers: 2,
    });
    const sales = vi.spyOn(merchant.analytics, 'sales').mockResolvedValue({
      granularity: 'day',
      series: [
        point('2026-11-19', 120_000),
        point('2026-11-20', 60_000),
        point('2026-11-21', 90_000),
      ],
      totals: { orders: 15, delivered: 12, revenue: 270_000 },
      previousTotals: { orders: 10, delivered: 10, revenue: 180_000 },
    });
    vi.spyOn(merchant.analytics, 'items').mockResolvedValue([
      { foodItemId: 'i1', name: 'Chicken Biryani', quantity: 9, revenue: 288_000 },
      { foodItemId: 'i2', name: 'Raita', quantity: 4, revenue: 12_000 },
    ]);
    vi.spyOn(merchant.analytics, 'categories').mockResolvedValue([
      { categoryId: 'c1', name: 'Biryani', quantity: 9, revenue: 288_000 },
    ]);
    vi.spyOn(merchant.analytics, 'operations').mockResolvedValue({
      orders: 15,
      acceptanceRate: 93.3,
      rejectionRate: 6.7,
      timeoutRate: 0,
      restaurantCancellationRate: 0,
      avgAcceptSeconds: 75,
      avgPrepSeconds: 1_140,
      lateReadyRate: 10,
    });
    renderAt('/analytics');
    const chart = await screen.findByRole('img', { name: /Revenue by day: 3 bars/ });
    expect(chart.querySelectorAll('rect')).toHaveLength(3);
    expect(screen.getAllByTestId('sales-bar')).toHaveLength(3);
    expect(screen.getByText('₹2,700')).toBeInTheDocument();
    expect(screen.getAllByText('+50% vs previous period')).toHaveLength(2);
    const top = screen.getByRole('list', { name: 'Top dishes by quantity' });
    expect(within(top).getAllByRole('listitem')).toHaveLength(2);
    expect(within(top).getByText('9 sold · ₹2,880')).toBeInTheDocument();
    expect(screen.getByText('93.3%')).toBeInTheDocument();
    expect(sales).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ granularity: 'day', from: expect.any(String) }),
    );
  });
});

describe('reviews (API-RREV-001…004)', () => {
  it('responds once and edits only within the window', async () => {
    const review = (over: Partial<BranchReview>): BranchReview => ({
      id: 'rv1',
      orderId: 'o1',
      rating: 4,
      text: 'Lovely biryani',
      tags: [],
      photos: [],
      status: 'PUBLISHED',
      author: 'Asha',
      orderNumber: '261121-AAAAAA',
      response: null,
      createdAt: new Date().toISOString(),
      ...over,
    });
    const list = vi.spyOn(merchant.reviews, 'list').mockResolvedValue({
      data: [
        review({}),
        review({
          id: 'rv2',
          author: 'Kiran',
          response: { text: 'Thanks Kiran!', at: new Date().toISOString(), editable: true },
        }),
        review({
          id: 'rv3',
          author: 'Meera',
          rating: 2,
          response: { text: 'Sorry, Meera.', at: new Date().toISOString(), editable: false },
        }),
      ],
      nextCursor: null,
    });
    const respond = vi
      .spyOn(merchant.reviews, 'respond')
      .mockResolvedValue({ reviewId: 'rv1', text: 'Thank you!' });
    const edit = vi
      .spyOn(merchant.reviews, 'editResponse')
      .mockResolvedValue({ reviewId: 'rv2', text: 'Thanks a lot, Kiran!' });
    renderAt('/reviews');

    const asha = await screen.findByRole('article', { name: 'Review from Asha' });
    fireEvent.change(within(asha).getByLabelText('Respond publicly'), {
      target: { value: 'Thank you!' },
    });
    fireEvent.click(within(asha).getByRole('button', { name: 'Post response' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith('rv1', 'Thank you!'));

    const kiran = screen.getByRole('article', { name: 'Review from Kiran' });
    fireEvent.click(within(kiran).getByRole('button', { name: 'Edit response' }));
    fireEvent.change(within(kiran).getByLabelText('Edit your response'), {
      target: { value: 'Thanks a lot, Kiran!' },
    });
    fireEvent.click(within(kiran).getByRole('button', { name: 'Save response' }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith('rv2', 'Thanks a lot, Kiran!'));

    const meera = screen.getByRole('article', { name: 'Review from Meera' });
    expect(within(meera).queryByRole('button', { name: 'Edit response' })).not.toBeInTheDocument();
    expect(within(meera).getByText(/edited for 24 hours/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Response'), { target: { value: 'no' } });
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith('b1', { responded: false, limit: 20 }),
    );
  });
});

describe('payouts (FR-RFIN-002)', () => {
  it('lists payouts with their status and the bank change in review', async () => {
    vi.spyOn(merchant.restaurant, 'payouts').mockResolvedValue({
      data: [
        {
          id: 'p1',
          periodStart: '2026-11-09T18:30:00.000Z',
          periodEnd: '2026-11-16T18:30:00.000Z',
          amount: 1_250_000,
          status: 'PAID',
          utr: 'UTR123456',
          failureReason: null,
          paidAt: '2026-11-18T06:00:00.000Z',
          createdAt: '2026-11-17T06:00:00.000Z',
          bank: { accountMasked: 'XXXXXX4321', ifsc: 'HDFC0001234' },
          settlement: {
            gross: 1_500_000,
            commission: 225_000,
            discounts: 0,
            taxes: 25_000,
            adjustments: 0,
            net: 1_250_000,
          },
        },
        {
          id: 'p2',
          periodStart: '2026-11-02T18:30:00.000Z',
          periodEnd: '2026-11-09T18:30:00.000Z',
          amount: 300_000,
          status: 'FAILED',
          utr: null,
          failureReason: 'Account closed',
          paidAt: null,
          createdAt: '2026-11-10T06:00:00.000Z',
          bank: null,
          settlement: null,
        },
      ],
      nextCursor: null,
    });
    vi.spyOn(merchant.restaurant, 'get').mockResolvedValue({
      bank: {
        holderName: 'Saffron LLP',
        accountMasked: 'XXXXXX4321',
        ifsc: 'HDFC0001234',
        status: 'VERIFIED',
      },
    } as never);
    vi.spyOn(merchant.restaurant, 'changeRequests').mockResolvedValue([
      {
        id: 'cr1',
        type: 'BANK_ACCOUNT',
        status: 'PENDING',
        reason: null,
        createdAt: '2026-11-20T06:00:00.000Z',
        decidedAt: null,
      },
    ]);
    renderAt('/payouts');
    const table = await screen.findByRole('table', { name: 'Payout history' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('₹12,500');
    expect(rows[1]).toHaveTextContent('Paid');
    expect(rows[1]).toHaveTextContent('UTR UTR123456');
    expect(rows[2]).toHaveTextContent('Failed');
    expect(rows[2]).toHaveTextContent('Account closed');
    expect(await screen.findByText(/Saffron LLP · XXXXXX4321/)).toBeInTheDocument();
    expect(screen.getByText(/waiting for verification/)).toBeInTheDocument();
  });
});
