import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  type Address,
  type Cart,
  type CustomerOrderDetails,
  type CustomerOrderSummary,
  type InboxNotification,
  type MyReview,
  type OrderTracking,
  type SupportTicketThread,
} from '@fos/api-client';
import { AuthProvider } from '@fos/auth-web';
import { AppLayout } from '../components/AppLayout';
import { api } from '../lib/api';
import { AUTH_CONFIG } from '../lib/auth';
import { customer } from '../lib/customer';
import { setDeliveryLocation } from '../lib/location';
import { shopRoutes } from '../router';
import { NotFoundPage } from './NotFoundPage';

/* A stand-in socket: tests push events through `emit`. */
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(env: unknown) => void>>();
  return {
    emit(event: string, data: Record<string, unknown>, aggregate = { type: 'user', id: 'u1' }) {
      const env = {
        eventId: crypto.randomUUID(),
        event,
        occurredAt: new Date().toISOString(),
        aggregate: { ...aggregate, version: 0 },
        data,
      };
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
      subscribe() {
        return { ready: Promise.resolve({ ok: true }), unsubscribe() {} };
      },
    },
  };
});
vi.mock('@fos/api-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRealtime: () => socket.live,
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const user = {
  id: 'u1',
  fullName: 'Asha Rao',
  email: 'asha@example.com',
  phone: '+919800000001',
  emailVerified: false,
  phoneVerified: true,
  status: 'ACTIVE' as const,
  roles: [],
  scope: 'FULL' as const,
  profileComplete: true,
};

const emptyCart: Cart = {
  id: null,
  version: 0,
  branch: null,
  lines: [],
  itemCount: 0,
  instructions: null,
  noCutlery: false,
  coupon: null,
  preview: null,
  delivery: null,
  blocking: [],
  warnings: [],
};

const summary = (over: Partial<CustomerOrderSummary> = {}): CustomerOrderSummary => ({
  id: 'o1',
  number: 'FOS-24001',
  status: 'DELIVERED',
  statusLabel: 'Delivered',
  restaurant: {
    id: 'r1',
    name: 'Saffron Kitchen',
    logoFileId: null,
    branchId: 'b1',
    branchName: 'Koramangala',
  },
  itemsSummary: '2 × Dal Makhani',
  itemCount: 2,
  totalAmount: 49_000,
  paymentMethod: 'ONLINE',
  refundStatus: null,
  createdAt: ago(5 * HOUR),
  placedAt: ago(5 * HOUR),
  deliveredAt: ago(4 * HOUR),
  cancelledAt: null,
  eta: null,
  ...over,
});

const details = (over: Partial<CustomerOrderDetails> = {}): CustomerOrderDetails => ({
  ...summary(),
  version: 4,
  items: [
    {
      id: 'oi1',
      foodItemId: 'i1',
      itemName: 'Dal Makhani',
      variantName: null,
      dietaryMarker: 'VEG',
      unitPriceAmount: 22_000,
      optionsAmount: 0,
      itemDiscountAmount: 0,
      quantity: 2,
      lineTotalAmount: 44_000,
      instructions: null,
      options: [],
    },
  ],
  breakdown: {
    components: [],
    itemsSubtotal: 44_000,
    discountTotal: 0,
    taxTotal: 2_000,
    tip: 0,
    walletApplied: 0,
    total: 49_000,
    payable: 49_000,
  },
  address: null,
  contact: { name: 'Asha Rao', phone: '+919800000001' },
  deliveryInstructions: null,
  cookingInstructions: null,
  payments: [],
  refunds: [],
  cancellation: null,
  timeline: [],
  invoiceAvailable: true,
  reviewed: false,
  ...over,
});

const tracking = (over: Partial<OrderTracking> = {}): OrderTracking => ({
  orderId: 'o1',
  number: 'FOS-24001',
  status: 'DELIVERED',
  eta: null,
  restaurant: { name: 'Saffron Kitchen, Koramangala', lat: 12.93, lng: 77.62 },
  destination: { lat: 12.91, lng: 77.64 },
  delivery: {
    status: 'DELIVERED',
    assignedAt: ago(5 * HOUR),
    arrivedRestaurantAt: null,
    pickedUpAt: null,
    arrivedCustomerAt: null,
    deliveredAt: ago(4 * HOUR),
  },
  partner: { firstName: 'Ravi', vehicleType: 'SCOOTER', rating: 4.8 },
  location: null,
  route: null,
  deliveryCode: null,
  live: false,
  ...over,
});

const address = (over: Partial<Address> = {}): Address => ({
  id: 'a1',
  label: 'HOME',
  customLabel: null,
  line1: '12 Lake View',
  line2: null,
  landmark: null,
  area: 'HSR Layout',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560102',
  location: { lat: 12.91, lng: 77.64 },
  contactName: 'Asha Rao',
  contactPhone: '+919800000001',
  instructions: null,
  isDefault: true,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...over,
});

const review = (over: Partial<MyReview> = {}): MyReview => ({
  id: 'rv1',
  orderId: 'o1',
  target: 'RESTAURANT',
  rating: 4,
  text: 'Great dal',
  tags: ['TASTE'],
  photos: [],
  status: 'PUBLISHED',
  editable: true,
  editableUntil: new Date(Date.now() + 10 * HOUR).toISOString(),
  response: null,
  createdAt: ago(2 * HOUR),
  orderNumber: 'FOS-24001',
  restaurant: 'Saffron Kitchen, Koramangala',
  ...over,
});

const note = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  id: 'n1',
  category: 'ORDER_UPDATES',
  title: 'Order delivered',
  body: 'Enjoy your meal!',
  deepLink: null,
  data: null,
  read: false,
  readAt: null,
  createdAt: ago(HOUR),
  ...over,
});

const thread = (over: Partial<SupportTicketThread> = {}): SupportTicketThread => ({
  id: 't1',
  number: 'S261121-AB12',
  category: 'REFUND',
  subject: 'Refund not received for my order',
  status: 'OPEN',
  priority: 'NORMAL',
  orderId: null,
  createdAt: ago(HOUR),
  resolvedAt: null,
  csat: null,
  canReopen: false,
  messages: [
    {
      id: 'm1',
      from: 'YOU',
      body: 'Refund not received for my order',
      attachments: [],
      at: ago(HOUR),
    },
  ],
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
          ...shopRoutes,
          { path: 'sign-in', element: <p>Sign in page</p> },
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
  setDeliveryLocation({ lat: 12.935, lng: 77.624, label: 'Koramangala' });
  vi.spyOn(customer.cart, 'get').mockResolvedValue(emptyCart);
  vi.spyOn(customer.notifications, 'unreadCount').mockResolvedValue({ unread: 0 });
});

describe('customer account area', () => {
  it('pages through order history and filters by status', async () => {
    const history = vi
      .spyOn(customer.orders, 'history')
      .mockResolvedValueOnce({ data: [summary()], nextCursor: 'c2' })
      .mockResolvedValueOnce({
        data: [
          summary({
            id: 'o2',
            number: 'FOS-23990',
            restaurant: { ...summary().restaurant, name: 'Biryani House' },
          }),
        ],
        nextCursor: null,
      })
      .mockResolvedValue({ data: [], nextCursor: null });
    renderAt('/orders');

    const list = await screen.findByRole('list', { name: 'Orders' });
    expect(within(list).getByText('Saffron Kitchen')).toBeInTheDocument();
    expect(history).toHaveBeenLastCalledWith({ status: undefined });

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(list).findByText('Biryani House')).toBeInTheDocument();
    expect(history).toHaveBeenLastCalledWith({ status: undefined, cursor: 'c2' });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Cancelled' }));
    expect(await screen.findByText('No orders here yet')).toBeInTheDocument();
    expect(history).toHaveBeenLastCalledWith({ status: 'CANCELLED' });
  });

  it('reorders and says which items were unavailable', async () => {
    vi.spyOn(customer.orders, 'history').mockResolvedValue({
      data: [summary()],
      nextCursor: null,
    });
    const reorder = vi.spyOn(customer.orders, 'reorder').mockResolvedValue({
      added: ['Dal Makhani'],
      skipped: [{ itemName: 'Paneer Pizza', reason: 'ITEM_UNAVAILABLE' }],
      cart: { ...emptyCart, itemCount: 2 },
    });
    renderAt('/orders');

    fireEvent.click(await screen.findByRole('button', { name: 'Reorder FOS-24001' }));
    const alert = await screen.findByText('Some items couldn’t be added');
    expect(reorder).toHaveBeenCalledWith('o1', false);
    const box = alert.closest('[role="status"]') as HTMLElement;
    expect(box).toHaveTextContent('Paneer Pizza isn’t available right now.');
    expect(box).toHaveTextContent('We added Dal Makhani to your cart.');
    expect(within(box).getByRole('link', { name: 'View cart' })).toHaveAttribute('href', '/cart');
  });

  it('rates a delivered order: restaurant stars, tags, text, photo and the partner', async () => {
    vi.spyOn(customer.tracking, 'snapshot').mockResolvedValue(tracking());
    vi.spyOn(customer.orders, 'details').mockResolvedValue(details());
    const upload = vi.spyOn(customer.files, 'upload').mockResolvedValue({
      id: 'f1',
      purpose: 'REVIEW_PHOTO',
      mimeType: 'image/jpeg',
      urls: null,
    });
    const submit = vi.spyOn(customer.reviews, 'submit').mockResolvedValue([]);
    renderAt('/orders/o1');

    fireEvent.click(await screen.findByRole('button', { name: 'Rate this order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rate your order' });
    const food = within(dialog).getByRole('group', {
      name: 'How was the food from Saffron Kitchen?',
    });
    fireEvent.click(within(food).getByLabelText('4 stars'));
    fireEvent.click(within(dialog).getByLabelText('Taste'));
    fireEvent.change(within(dialog).getByLabelText('Tell others about it (optional)'), {
      target: { value: 'Lovely dal' },
    });
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'dal.jpg', {
      type: 'image/jpeg',
    });
    fireEvent.change(within(dialog).getByLabelText(/Add photos/), {
      target: { files: [photo] },
    });
    expect(await within(dialog).findByText('dal.jpg')).toBeInTheDocument();
    expect(upload).toHaveBeenCalledWith(photo, 'REVIEW_PHOTO', 'dal.jpg');

    const delivery = within(dialog).getByRole('group', { name: 'How was the delivery?' });
    fireEvent.click(within(delivery).getByLabelText('5 stars'));
    fireEvent.click(within(dialog).getByLabelText('On time'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit rating' }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const [orderId, body, key] = submit.mock.calls[0]!;
    expect(orderId).toBe('o1');
    expect(body).toEqual({
      restaurant: { rating: 4, tags: ['TASTE'], text: 'Lovely dal', photoFileIds: ['f1'] },
      partner: { rating: 5, tags: ['ON_TIME'] },
    });
    expect(key).toMatch(UUID);
    expect(await screen.findByText('Thanks for your feedback!')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rate this order' })).not.toBeInTheDocument();
  });

  it('reports a missing item with quantities', async () => {
    vi.spyOn(customer.tracking, 'snapshot').mockResolvedValue(tracking());
    vi.spyOn(customer.orders, 'details').mockResolvedValue(details({ reviewed: true }));
    const report = vi.spyOn(customer.orders, 'reportIssue').mockResolvedValue({
      id: 'is1',
      type: 'MISSING_ITEM',
      status: 'OPEN',
      description: 'One dal was missing from the bag',
      items: [{ orderItemId: 'oi1', quantity: 1 }],
      refund: { amount: 22_000, status: 'UNDER_REVIEW', destination: 'WALLET' },
      resolution: null,
      ticket: { id: 't9', number: 'S261121-XY99' },
      createdAt: new Date().toISOString(),
    });
    renderAt('/orders/o1');

    fireEvent.click(await screen.findByRole('button', { name: 'Report an issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report an issue' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Increase Dal Makhani' }));
    fireEvent.change(within(dialog).getByLabelText('Describe the problem'), {
      target: { value: 'short' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect(
      await within(dialog).findByText('Tell us a little more (at least 10 characters).'),
    ).toBeInTheDocument();
    expect(report).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Describe the problem'), {
      target: { value: 'One dal was missing from the bag' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report.mock.calls[0]![1]).toEqual({
      type: 'MISSING_ITEM',
      description: 'One dal was missing from the bag',
      items: [{ orderItemId: 'oi1', quantity: 1 }],
      requestRefund: true,
    });
    expect(report.mock.calls[0]![2]).toMatch(UUID);
    expect(await screen.findByRole('link', { name: 'View ticket S261121-XY99' })).toHaveAttribute(
      'href',
      '/help/tickets/t9',
    );
  });

  it('blocks editing a review after the 48-hour window', async () => {
    vi.spyOn(customer.reviews, 'mine').mockResolvedValue({
      data: [
        review({ id: 'old', editable: false, editableUntil: ago(HOUR), text: 'Old review' }),
        review({ id: 'new', text: 'New review' }),
      ],
      nextCursor: null,
    });
    const edit = vi
      .spyOn(customer.reviews, 'edit')
      .mockRejectedValue(
        new ApiClientError(
          'REVIEW_EDIT_WINDOW_CLOSED',
          'This review can no longer be edited.',
          422,
        ),
      );
    renderAt('/account/reviews');

    const oldCard = (await screen.findByText('Old review')).closest('li') as HTMLElement;
    expect(within(oldCard).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(oldCard).getByText('The 48-hour editing window has passed.')).toBeInTheDocument();

    // The server has the final say: a window that closes meanwhile is explained too.
    const newCard = screen.getByText('New review').closest('li') as HTMLElement;
    fireEvent.click(within(newCard).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(newCard).getByLabelText('5 stars'));
    fireEvent.click(within(newCard).getByRole('button', { name: 'Save changes' }));
    expect(
      await within(newCard).findByText('This review can no longer be edited.'),
    ).toBeInTheDocument();
    expect(edit).toHaveBeenCalledWith(
      'new',
      { rating: 5, text: 'New review', tags: ['TASTE'] },
      expect.stringMatching(UUID),
    );
    expect(within(newCard).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('validates a new address, saves it and changes the default', async () => {
    const second = address({ id: 'a2', label: 'WORK', line1: '5 Tech Park', isDefault: false });
    const list = vi.spyOn(customer.addresses, 'list').mockResolvedValue([address(), second]);
    const create = vi
      .spyOn(customer.addresses, 'create')
      .mockResolvedValue(address({ id: 'a3', isDefault: false }));
    const setDefault = vi
      .spyOn(customer.addresses, 'setDefault')
      .mockResolvedValue({ ...second, isDefault: true });
    renderAt('/account/addresses');

    fireEvent.click(await screen.findByRole('button', { name: 'Add address' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add address' });
    fireEvent.change(within(dialog).getByLabelText('House / flat, building'), {
      target: { value: 'Flat 4B' },
    });
    fireEvent.change(within(dialog).getByLabelText('PIN code'), { target: { value: '012345' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save address' }));
    expect(await within(dialog).findByText('Enter a valid 6-digit PIN code')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter the area')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a latitude between -90 and 90')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('PIN code')).toHaveAttribute('aria-invalid', 'true');
    expect(create).not.toHaveBeenCalled();

    const fill = (label: string, value: string) =>
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    fill('Area', 'Indiranagar');
    fill('City', 'Bengaluru');
    fill('State', 'Karnataka');
    fill('PIN code', '560038');
    fill('Latitude', '12.97');
    fill('Longitude', '77.64');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save address' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        label: 'HOME',
        line1: 'Flat 4B',
        area: 'Indiranagar',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560038',
        location: { lat: 12.97, lng: 77.64 },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    list.mockResolvedValue([address({ isDefault: false }), { ...second, isDefault: true }]);
    const work = screen.getByRole('listitem', { name: 'Work: 5 Tech Park' });
    fireEvent.click(within(work).getByRole('button', { name: 'Set as default' }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith('a2'));
    expect(await within(work).findByText('Default')).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'Home: 12 Lake View' })).queryByText('Default'),
    ).not.toBeInTheDocument();
  });

  it('shows the wallet balance and pages through transactions', async () => {
    vi.spyOn(customer.wallet, 'summary').mockResolvedValue({
      currency: 'INR',
      availableAmount: 25_000,
      heldAmount: 0,
      expiringCredits: [{ amount: 5_000, source: 'PROMO', expiresAt: '2026-12-01T00:00:00Z' }],
    });
    const txns = vi
      .spyOn(customer.wallet, 'transactions')
      .mockResolvedValueOnce({
        data: [
          {
            id: 'w1',
            type: 'WALLET_CREDIT',
            description: 'Refund for order FOS-24001',
            amount: 12_000,
            reference: { type: 'refund', id: 'rf1' },
            createdAt: ago(HOUR),
          },
        ],
        nextCursor: 'w-next',
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'w2',
            type: 'WALLET_DEBIT',
            description: 'Paid for order FOS-23990',
            amount: -8_000,
            reference: { type: 'order', id: 'o2' },
            createdAt: ago(5 * HOUR),
          },
        ],
        nextCursor: null,
      });
    renderAt('/account/wallet');

    const balance = await screen.findByRole('region', { name: 'Wallet balance' });
    expect(await within(balance).findByText('₹250')).toBeInTheDocument();
    expect(screen.getByText(/Promotional credit · expires/)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Wallet transactions' });
    expect(within(list).getByText('+₹120')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(list).findByText('Paid for order FOS-23990')).toBeInTheDocument();
    expect(within(list).getByText('−₹80')).toBeInTheDocument();
    expect(txns).toHaveBeenLastCalledWith('w-next');
  });

  it('marks all notifications read and bumps the badge on a pushed notification', async () => {
    vi.spyOn(customer.notifications, 'unreadCount').mockResolvedValue({ unread: 2 });
    const list = vi.spyOn(customer.notifications, 'list').mockResolvedValue({
      data: [note(), note({ id: 'n2', title: 'Refund processed' })],
      nextCursor: null,
    });
    const markAll = vi
      .spyOn(customer.notifications, 'markAllRead')
      .mockResolvedValue({ updated: 2 });
    renderAt('/notifications');

    expect(
      await screen.findByRole('link', { name: 'Notifications, 2 unread' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Unread: Order delivered' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(markAll).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Order delivered' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByTestId('unread-badge')).not.toBeInTheDocument();

    const before = list.mock.calls.length;
    act(() =>
      socket.emit(
        'notification.created',
        {
          id: 'n3',
          title: 'Order on the way',
          body: 'Ravi picked it up',
          category: 'ORDER_UPDATES',
        },
        { type: 'notification', id: 'n3' },
      ),
    );
    expect(
      await screen.findByRole('link', { name: 'Notifications, 1 unread' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('unread-badge')).toHaveTextContent('1');
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
  });

  it('creates a support ticket and replies in its thread', async () => {
    vi.spyOn(customer.support, 'tickets').mockResolvedValue({ data: [], nextCursor: null });
    vi.spyOn(customer.orders, 'history').mockResolvedValue({
      data: [summary()],
      nextCursor: null,
    });
    const create = vi.spyOn(customer.support, 'create').mockResolvedValue(thread());
    vi.spyOn(customer.support, 'ticket').mockResolvedValue(thread());
    const reply = vi.spyOn(customer.support, 'reply').mockResolvedValue(
      thread({
        messages: [
          ...thread().messages,
          { id: 'm2', from: 'YOU', body: 'Any update?', attachments: [], at: ago(0) },
        ],
      }),
    );
    const router = renderAt('/help');

    expect(await screen.findByText('No requests yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New request' }));
    const form = screen.getByRole('form', { name: 'New request' });
    fireEvent.change(within(form).getByLabelText('What do you need help with?'), {
      target: { value: 'REFUND' },
    });
    await within(form).findByRole('option', { name: 'FOS-24001 · Saffron Kitchen' });
    fireEvent.change(within(form).getByLabelText('Related order (optional)'), {
      target: { value: 'o1' },
    });
    fireEvent.change(within(form).getByLabelText('Message'), {
      target: { value: 'Refund not received for my order' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Send request' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        category: 'REFUND',
        description: 'Refund not received for my order',
        orderId: 'o1',
      }),
    );
    expect(await screen.findByText('We have received your request')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/help/tickets/t1');

    fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: 'Any update?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(reply).toHaveBeenCalledWith('t1', { body: 'Any update?' }));
    const messages = screen.getByRole('list', { name: 'Messages' });
    expect(await within(messages).findByText('Any update?')).toBeInTheDocument();
    expect(screen.getByLabelText('Your reply')).toHaveValue('');
  });

  it('removes a favourite restaurant', async () => {
    const card = {
      branchId: 'b1',
      restaurantId: 'r1',
      restaurantName: 'Saffron Kitchen',
      branchName: 'Koramangala',
      slug: 'saffron-kitchen',
      area: 'Koramangala',
      logoUrl: null,
      coverUrl: null,
      cuisines: [],
      rating: { average: 4.4, count: 120, isNew: false },
      priceForTwoAmount: null,
      pureVeg: false,
      status: {
        state: 'OPEN' as const,
        acceptingOrders: true,
        reason: null,
        opensAt: null,
        lastOrderAt: null,
      },
      delivery: null,
      bestOffer: null,
      isFavorite: true,
    };
    const favorites = vi.spyOn(customer.favorites, 'restaurants').mockResolvedValue([
      { restaurantId: 'r1', serviceable: true, card },
      {
        restaurantId: 'r2',
        serviceable: false,
        card: { ...card, branchId: 'b2', restaurantId: 'r2', restaurantName: 'Biryani House' },
      },
    ]);
    const remove = vi.spyOn(customer.favorites, 'removeRestaurant').mockResolvedValue(null);
    renderAt('/account/favourites');

    const list = await screen.findByRole('list', { name: 'Favourite restaurants' });
    expect(within(list).getByText('Doesn’t deliver to Koramangala')).toBeInTheDocument();
    expect(favorites).toHaveBeenCalledWith({ lat: 12.935, lng: 77.624 });
    favorites.mockResolvedValue([
      {
        restaurantId: 'r2',
        serviceable: false,
        card: { ...card, branchId: 'b2', restaurantId: 'r2', restaurantName: 'Biryani House' },
      },
    ]);
    fireEvent.click(
      within(list).getByRole('button', { name: 'Remove Saffron Kitchen from favourites' }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledWith('r1'));
    await waitFor(() =>
      expect(within(list).queryByText('Saffron Kitchen')).not.toBeInTheDocument(),
    );
    expect(within(list).getByText('Biryani House')).toBeInTheDocument();
  });

  it('updates the name and food preferences, and links to sign-in security', async () => {
    const profile = {
      id: 'u1',
      fullName: 'Asha Rao',
      email: 'asha@example.com',
      phone: '+919800000001',
      emailVerified: false,
      phoneVerified: true,
      avatarUrl: null,
      locale: 'en-IN',
      createdAt: '2026-01-01T00:00:00Z',
    };
    vi.spyOn(customer.profile, 'get').mockResolvedValue(profile);
    vi.spyOn(customer.profile, 'preferences').mockResolvedValue({
      vegOnlyDefault: false,
      dietaryTags: [],
      allergens: [],
    });
    const update = vi
      .spyOn(customer.profile, 'update')
      .mockResolvedValue({ ...profile, fullName: 'Asha R. Rao' });
    const prefs = vi.spyOn(customer.profile, 'updatePreferences').mockResolvedValue({
      vegOnlyDefault: true,
      dietaryTags: [],
      allergens: ['PEANUTS'],
    });
    renderAt('/account/profile');

    expect(await screen.findByText(/Not verified/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage sign-in and security' })).toHaveAttribute(
      'href',
      '/account/security',
    );
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Asha R. Rao' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ fullName: 'Asha R. Rao' }));
    expect(await screen.findByText('Profile updated.')).toBeInTheDocument();
    expect(api.authStore.getState().user?.fullName).toBe('Asha R. Rao');

    const form = await screen.findByRole('form', { name: 'Food preferences' });
    fireEvent.click(within(form).getByLabelText('Show vegetarian food only by default'));
    fireEvent.click(within(form).getByLabelText('Peanuts'));
    fireEvent.click(within(form).getByRole('button', { name: 'Save preferences' }));
    await waitFor(() =>
      expect(prefs).toHaveBeenCalledWith({
        vegOnlyDefault: true,
        dietaryTags: [],
        allergens: ['PEANUTS'],
      }),
    );
    expect(await within(form).findByText('Preferences saved.')).toBeInTheDocument();
  });

  it('opens the account menu with every section', async () => {
    vi.spyOn(customer.orders, 'history').mockResolvedValue({ data: [], nextCursor: null });
    renderAt('/orders');
    const toggle = await screen.findByRole('button', { name: /Account|Asha Rao/ });
    fireEvent.click(toggle);
    const nav = screen.getByRole('navigation', { name: 'Account' });
    for (const name of [
      'Orders',
      'Favourites',
      'Addresses',
      'Wallet',
      'Notifications',
      'Help',
      'Profile',
      'Sign-in & security',
    ])
      expect(within(nav).getByRole('link', { name: new RegExp(name) })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('navigation', { name: 'Account' })).not.toBeInTheDocument();
  });
});
