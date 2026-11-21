import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  type BranchCard,
  type BranchPage,
  type Cart,
  type CheckoutSession,
  type CustomerOrderDetails,
  type ItemCard,
  type ItemDetails,
  type OrderTracking,
  type PriceQuote,
} from '@fos/api-client';
import { AuthProvider } from '@fos/auth-web';
import { AppLayout } from '../components/AppLayout';
import { api } from '../lib/api';
import { AUTH_CONFIG } from '../lib/auth';
import { customer } from '../lib/customer';
import { setDeliveryLocation } from '../lib/location';
import { shopRoutes } from '../router';
import { NotFoundPage } from './NotFoundPage';

/* A stand-in socket: tests push customer events through `emit`. */
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(env: unknown) => void>>();
  return {
    subscribed: [] as { type: string; id?: string }[],
    emit(event: string, data: Record<string, unknown>, aggregate = { type: 'order', id: 'o1' }) {
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
      subscribe(type: string, id?: string) {
        socket.subscribed.push({ type, id });
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

const user = {
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

const card = (over: Partial<BranchCard> = {}): BranchCard => ({
  branchId: 'b1',
  restaurantId: 'r1',
  restaurantName: 'Saffron Kitchen',
  branchName: 'Koramangala',
  slug: 'saffron-kitchen-koramangala',
  area: 'Koramangala',
  logoUrl: null,
  coverUrl: null,
  cuisines: ['North Indian', 'Biryani'],
  rating: { average: null, count: 0, isNew: true },
  priceForTwoAmount: 50_000,
  pureVeg: false,
  status: { state: 'OPEN', acceptingOrders: true, reason: null, opensAt: null, lastOrderAt: null },
  delivery: {
    serviceable: true,
    reason: null,
    distanceKm: 2.1,
    eta: { minMinutes: 25, maxMinutes: 35 },
    deliveryFeeAmount: 3_000,
    surge: { amount: 0, reason: null },
  },
  bestOffer: '20% off up to ₹100',
  isFavorite: false,
  ...over,
});

const branchPage = (): BranchPage => ({
  ...card(),
  description: null,
  address: {
    line1: '1 Main Rd',
    line2: null,
    area: 'Koramangala',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560034',
  },
  location: { lat: 12.93, lng: 77.62 },
  fssaiNumber: '11223344556677',
  minOrderAmount: 10_000,
  maxOrderAmount: null,
  hours: {
    timezone: 'Asia/Kolkata',
    today: { weekday: 1, name: 'Monday', slots: [] },
    week: [],
    upcomingHolidays: [],
  },
  offers: [],
  deliveryDetails: null,
});

const item = (over: Partial<ItemCard> = {}): ItemCard => ({
  id: 'i1',
  categoryId: 'c1',
  name: 'Dal Makhani',
  description: null,
  imageUrl: null,
  priceAmount: 22_000,
  originalPriceAmount: null,
  dietaryMarker: 'VEG',
  tags: [],
  spiceLevel: null,
  isBestseller: false,
  isRecommended: false,
  isTodaysSpecial: false,
  customizable: false,
  available: true,
  unavailableReason: null,
  availableAt: null,
  ...over,
});

const pizza = item({ id: 'i2', name: 'Paneer Pizza', priceAmount: 30_000, customizable: true });

const pizzaDetails: ItemDetails = {
  ...pizza,
  images: [],
  servingSize: null,
  prepMinutes: null,
  ingredients: [],
  allergens: [],
  allergenWarnings: [],
  variants: [
    { id: 'v1', name: 'Regular', priceAmount: 30_000, isDefault: true },
    { id: 'v2', name: 'Large', priceAmount: 45_000, isDefault: false },
  ],
  customizationGroups: [
    {
      id: 'g1',
      name: 'Base',
      minSelect: 1,
      maxSelect: 1,
      required: true,
      variantId: null,
      options: [
        {
          id: 'o1',
          name: 'Thin crust',
          priceDeltaAmount: 0,
          dietaryMarker: 'VEG',
          isDefault: false,
          available: true,
        },
        {
          id: 'o2',
          name: 'Cheese burst',
          priceDeltaAmount: 5_000,
          dietaryMarker: 'VEG',
          isDefault: false,
          available: true,
        },
      ],
    },
  ],
};

const quote = (over: Partial<PriceQuote> = {}): PriceQuote => ({
  pricingVersion: 1,
  feeScheduleId: 'f1',
  lines: [],
  itemsSubtotal: 44_000,
  itemDiscountTotal: 0,
  discounts: [],
  couponNotice: null,
  couponShortfall: null,
  packagingFee: 0,
  deliveryFee: 3_000,
  deliveryFeeWaived: 0,
  deliveryFeeKnown: true,
  surgeFee: 0,
  surgeReason: null,
  smallOrderFee: 0,
  platformFee: 0,
  taxes: [],
  taxTotal: 2_000,
  tip: 0,
  total: 49_000,
  walletApplied: 0,
  payable: 49_000,
  ...over,
});

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
  blocking: [{ code: 'CART_EMPTY', message: 'Your cart is empty.' }],
  warnings: [],
};

const fullCart = (over: Partial<Cart> = {}): Cart => ({
  ...emptyCart,
  id: 'cart1',
  version: 3,
  branch: {
    id: 'b1',
    restaurantId: 'r1',
    restaurantName: 'Saffron Kitchen',
    branchName: 'Koramangala',
    acceptingOrders: true,
    minOrderAmount: 10_000,
  },
  lines: [
    {
      id: 'l1',
      foodItemId: 'i1',
      name: 'Dal Makhani',
      dietaryMarker: 'VEG',
      variant: null,
      options: [],
      quantity: 2,
      instructions: null,
      unitAmount: 22_000,
      lineAmount: 44_000,
      status: 'OK',
      previousUnitAmount: null,
      message: null,
    },
  ],
  itemCount: 2,
  preview: quote(),
  blocking: [],
  ...over,
});

const address = {
  id: 'a1',
  label: 'HOME' as const,
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
  serviceability: { serviceable: true, reason: null, distanceKm: 3.2 },
};

const session = (over: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 's1',
  status: 'OPEN',
  version: 0,
  expiresAt: '2026-11-21T10:15:00Z',
  branchId: 'b1',
  address,
  paymentMethod: 'ONLINE',
  useWallet: false,
  tipAmount: 0,
  deliveryInstructions: null,
  contactless: false,
  contact: { name: 'Asha Rao', phone: '+919800000001' },
  delivery: { distanceKm: 3.2, eta: { minMinutes: 30, maxMinutes: 40 } },
  quote: quote(),
  payableAmount: 49_000,
  ...over,
});

const tracking = (over: Partial<OrderTracking> = {}): OrderTracking => ({
  orderId: 'o1',
  number: 'FOS-24001',
  status: 'PLACED',
  eta: { minAt: '2026-11-21T07:00:00Z', maxAt: '2026-11-21T07:10:00Z' },
  restaurant: { name: 'Saffron Kitchen, Koramangala', lat: 12.93, lng: 77.62 },
  destination: { lat: 12.91, lng: 77.64 },
  delivery: null,
  partner: null,
  location: null,
  route: null,
  deliveryCode: null,
  live: false,
  ...over,
});

const details = (over: Partial<CustomerOrderDetails> = {}): CustomerOrderDetails => ({
  id: 'o1',
  number: 'FOS-24001',
  status: 'PLACED',
  statusLabel: 'Order placed',
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
  createdAt: '2026-11-21T06:30:00Z',
  placedAt: '2026-11-21T06:30:00Z',
  deliveredAt: null,
  cancelledAt: null,
  eta: null,
  version: 1,
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
  timeline: [
    { status: 'PLACED', label: 'Order placed', at: '2026-11-21T06:30:00Z', by: 'CUSTOMER' },
  ],
  invoiceAvailable: false,
  reviewed: false,
  ...over,
});

function renderAt(path: string, { signedIn = true } = {}) {
  api.authStore.setState(
    signedIn
      ? { status: 'signedIn', user, accessToken: 't', accessTokenExpiresAt: null }
      : { status: 'signedOut', user: null, accessToken: null, accessTokenExpiresAt: null },
  );
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

function mockRestaurant(items: ItemCard[] = [item(), pizza]) {
  vi.spyOn(customer.branches, 'page').mockResolvedValue(branchPage());
  vi.spyOn(customer.branches, 'menu').mockResolvedValue({
    branchId: 'b1',
    menuVersion: 1,
    vegOnly: false,
    sections: [],
    categories: [{ id: 'c1', name: 'Mains', description: null, items }],
  });
  vi.spyOn(customer.coupons, 'list').mockResolvedValue([
    {
      code: 'SAVE50',
      description: '₹50 off above ₹300',
      discountType: 'FLAT',
      eligible: true,
      reason: null,
    },
  ]);
}

beforeEach(() => {
  vi.restoreAllMocks();
  socket.subscribed.length = 0;
  setDeliveryLocation({ lat: 12.935, lng: 77.624, label: 'Koramangala' });
  vi.spyOn(customer.cart, 'get').mockResolvedValue(emptyCart);
  vi.spyOn(customer.notifications, 'unreadCount').mockResolvedValue({ unread: 0 });
});

describe('customer ordering journey', () => {
  it('lists restaurants for the chosen location and filters them', async () => {
    vi.spyOn(customer.geo, 'serviceability').mockResolvedValue({
      serviceable: true,
      reason: null,
      zone: { id: 'z1', name: 'Koramangala', city: 'Bengaluru' },
      branch: null,
    });
    vi.spyOn(customer.discovery, 'cuisines').mockResolvedValue([
      { slug: 'biryani', name: 'Biryani', restaurantCount: 4 },
    ]);
    const list = vi
      .spyOn(customer.discovery, 'restaurants')
      .mockResolvedValue({ data: [card()], nextCursor: null });
    renderAt('/', { signedIn: false });

    expect(await screen.findByText('Saffron Kitchen')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('25–35 min')).toBeInTheDocument();
    expect(screen.getByText('₹30 delivery')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Delivering to Koramangala/ })).toHaveAttribute(
      'href',
      '/location',
    );
    expect(list).toHaveBeenCalledWith({ lat: 12.935, lng: 77.624 }, { sort: 'recommended' });

    fireEvent.click(screen.getByRole('button', { name: 'Pure veg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Biryani' }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        { lat: 12.935, lng: 77.624 },
        { sort: 'recommended', cuisines: ['biryani'], pureVeg: true },
      ),
    );
  });

  it('asks for a location before showing restaurants', async () => {
    setDeliveryLocation(null);
    renderAt('/', { signedIn: false });
    expect(await screen.findByText('Set your delivery location')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose location' })).toHaveAttribute(
      'href',
      '/location',
    );
  });

  it('enforces a required option in the customisation sheet', async () => {
    mockRestaurant();
    vi.spyOn(customer.branches, 'item').mockResolvedValue(pizzaDetails);
    const add = vi.spyOn(customer.cart, 'add').mockResolvedValue(fullCart());
    renderAt('/restaurants/b1');

    expect(await screen.findByText('FSSAI Lic. No. 11223344556677')).toBeInTheDocument();
    expect(screen.getByText('SAVE50')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Paneer Pizza' }));
    const sheet = await screen.findByRole('dialog', { name: 'Paneer Pizza' });
    expect(within(sheet).getAllByText('Required · choose 1')).toHaveLength(2);

    fireEvent.click(within(sheet).getByRole('button', { name: /Add item · ₹300/ }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'Choose at least 1 for Base.',
    );
    expect(add).not.toHaveBeenCalled();

    fireEvent.click(within(sheet).getByLabelText(/Large/));
    fireEvent.click(within(sheet).getByLabelText(/Cheese burst/));
    fireEvent.click(within(sheet).getByRole('button', { name: /Add item · ₹500/ }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        branchId: 'b1',
        foodItemId: 'i2',
        variantId: 'v2',
        optionIds: ['o2'],
        quantity: 1,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('adds a dish to the cart and changes its quantity', async () => {
    mockRestaurant();
    const add = vi.spyOn(customer.cart, 'add').mockResolvedValue(fullCart({ itemCount: 1 }));
    const setQuantity = vi.spyOn(customer.cart, 'setQuantity').mockResolvedValue(fullCart());
    renderAt('/restaurants/b1');

    const addButton = await screen.findByRole('button', { name: 'Add Dal Makhani' });
    vi.mocked(customer.cart.get).mockResolvedValue(fullCart());
    fireEvent.click(addButton);
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        branchId: 'b1',
        foodItemId: 'i1',
        quantity: 1,
        optionIds: [],
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Increase Dal Makhani' }));
    await waitFor(() => expect(setQuantity).toHaveBeenCalledWith('l1', 3, 3));
    expect(screen.getByRole('link', { name: /2 items/ })).toHaveAttribute('href', '/cart');
  });

  it('offers to start a new cart when the cart is from another restaurant', async () => {
    mockRestaurant();
    const add = vi
      .spyOn(customer.cart, 'add')
      .mockRejectedValueOnce(
        new ApiClientError(
          'CART_BRANCH_CONFLICT',
          'Your cart has items from Biryani House. Start a new cart?',
          409,
        ),
      )
      .mockResolvedValueOnce(fullCart());
    renderAt('/restaurants/b1');

    fireEvent.click(await screen.findByRole('button', { name: 'Add Dal Makhani' }));
    const prompt = await screen.findByRole('dialog', { name: 'Start a new cart?' });
    expect(within(prompt).getByText(/items from Biryani House/)).toBeInTheDocument();
    fireEvent.click(within(prompt).getByRole('button', { name: 'Start new cart' }));
    await waitFor(() =>
      expect(add).toHaveBeenLastCalledWith({
        branchId: 'b1',
        foodItemId: 'i1',
        quantity: 1,
        optionIds: [],
        replaceCart: true,
      }),
    );
  });

  it('shows the price breakdown, flags changed prices and explains a rejected coupon', async () => {
    vi.mocked(customer.cart.get).mockResolvedValue(
      fullCart({
        lines: [{ ...fullCart().lines[0]!, status: 'PRICE_CHANGED', previousUnitAmount: 20_000 }],
      }),
    );
    vi.spyOn(customer.cart, 'applyCoupon').mockRejectedValue(
      new ApiClientError('COUPON_NOT_APPLICABLE', 'Add ₹100 more to use SAVE50.', 422),
    );
    renderAt('/cart');

    expect(await screen.findByText('Price changed from ₹200 to ₹220')).toBeInTheDocument();
    const bill = screen.getByLabelText('Price breakdown');
    expect(within(bill).getByText('₹440')).toBeInTheDocument();
    expect(within(bill).getByText('₹490')).toBeInTheDocument();
    expect(customer.cart.get).toHaveBeenCalledWith({ lat: 12.935, lng: 77.624 });

    fireEvent.change(screen.getByLabelText('Coupon code'), { target: { value: 'save50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Add ₹100 more to use SAVE50.');
    expect(customer.cart.applyCoupon).toHaveBeenCalledWith('SAVE50');
  });

  it('places a cash order with the confirmed total and an Idempotency-Key', async () => {
    vi.mocked(customer.cart.get).mockResolvedValue(fullCart());
    vi.spyOn(customer.addresses, 'list').mockResolvedValue([address]);
    vi.spyOn(customer.checkout, 'methods').mockResolvedValue([
      { method: 'ONLINE', available: true, reason: null },
      { method: 'COD', available: true, reason: null },
      { method: 'WALLET', available: false, reason: 'Your wallet has ₹0.00.', balance: 0 },
    ]);
    const create = vi.spyOn(customer.checkout, 'create').mockResolvedValue(session());
    const update = vi.spyOn(customer.checkout, 'update').mockResolvedValue(
      session({
        paymentMethod: 'COD',
        version: 1,
        payableAmount: 45_000,
        quote: quote({ payable: 45_000 }),
      }),
    );
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      order: {
        id: 'o1',
        number: 'FOS-24001',
        status: 'PLACED',
        payableAmount: 45_000,
        paymentMethod: 'COD',
      },
      payment: null,
      paymentError: null,
    });
    vi.spyOn(customer.tracking, 'snapshot').mockResolvedValue(tracking());
    vi.spyOn(customer.orders, 'details').mockResolvedValue(details());
    const router = renderAt('/checkout');

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        addressId: 'a1',
        paymentMethod: 'ONLINE',
        useWallet: false,
        tipAmount: 0,
        contactless: false,
      }),
    );
    expect(await screen.findByText('Arrives in about 30–40 min')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Cash on delivery/));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('s1', expect.objectContaining({ paymentMethod: 'COD' })),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Place order · ₹450' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body, headers] = post.mock.calls[0]!;
    expect(path).toBe('/checkout/sessions/s1/confirm');
    expect(body).toEqual({ expectedPayable: 45_000 });
    expect(headers?.['Idempotency-Key']).toMatch(UUID);
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders/o1'));
    expect(await screen.findByText('Order placed!')).toBeInTheDocument();
  });

  it('explains a price change at confirmation and re-quotes', async () => {
    vi.mocked(customer.cart.get).mockResolvedValue(fullCart());
    vi.spyOn(customer.addresses, 'list').mockResolvedValue([address]);
    vi.spyOn(customer.checkout, 'methods').mockResolvedValue([]);
    vi.spyOn(customer.checkout, 'create').mockResolvedValue(session());
    const update = vi
      .spyOn(customer.checkout, 'update')
      .mockResolvedValue(session({ payableAmount: 52_000, quote: quote({ payable: 52_000 }) }));
    vi.spyOn(customer.checkout, 'confirm').mockRejectedValue(
      new ApiClientError('PRICE_CHANGED', 'Prices changed', 409),
    );
    renderAt('/checkout');

    fireEvent.click(await screen.findByRole('button', { name: 'Place order & pay ₹490' }));
    expect(await screen.findByText(/The total changed since you last looked/)).toBeInTheDocument();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Place order & pay ₹520' })).toBeEnabled();
  });

  it('completes an online payment through the test checkout', async () => {
    vi.spyOn(customer.orders, 'details').mockResolvedValue(
      details({ status: 'PAYMENT_PENDING', statusLabel: 'Waiting for payment' }),
    );
    const initiate = vi.spyOn(customer.payments, 'initiate').mockResolvedValue({
      paymentId: 'pay1',
      provider: 'mock',
      keyId: 'rzp_test_mock',
      providerOrderId: 'order_1',
      amount: 49_000,
      currency: 'INR',
      orderNumber: 'FOS-24001',
      prefill: { name: 'Asha Rao', contact: null, email: null },
    });
    const checkout = vi
      .spyOn(customer.payments, 'mockCheckout')
      .mockResolvedValue({ providerPaymentId: 'pay_x', signature: 'sig' });
    const verify = vi.spyOn(customer.payments, 'verify').mockResolvedValue({
      id: 'pay1',
      orderId: 'o1',
      method: 'ONLINE',
      provider: 'mock',
      amount: 49_000,
      currency: 'INR',
      status: 'CAPTURED',
      capturedAmount: 49_000,
      refundedAmount: 0,
      instrumentSummary: 'UPI',
      failureReason: null,
      createdAt: '2026-11-21T06:30:00Z',
      capturedAt: '2026-11-21T06:31:00Z',
    });
    vi.spyOn(customer.tracking, 'snapshot').mockResolvedValue(tracking());
    const router = renderAt('/orders/o1/pay');

    fireEvent.click(await screen.findByRole('button', { name: 'Pay ₹490' }));
    await waitFor(() => expect(verify).toHaveBeenCalled());
    expect(initiate.mock.calls[0]![0]).toBe('o1');
    expect(initiate.mock.calls[0]![1]).toMatch(UUID);
    expect(checkout).toHaveBeenCalledWith('pay1', 'success');
    expect(verify.mock.calls[0]![1]).toEqual({ providerPaymentId: 'pay_x', signature: 'sig' });
    expect(verify.mock.calls[0]![2]).toMatch(UUID);
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders/o1'));
    expect(
      await screen.findByRole('heading', { name: 'Order placed — waiting for the restaurant' }),
    ).toBeInTheDocument();
  });

  it('reads the bank’s decline as a sentence before offering a retry', async () => {
    vi.spyOn(customer.orders, 'details').mockResolvedValue(
      details({ status: 'PAYMENT_PENDING', statusLabel: 'Waiting for payment' }),
    );
    vi.spyOn(customer.payments, 'initiate').mockResolvedValue({
      paymentId: 'pay1',
      provider: 'mock',
      keyId: 'rzp_test_mock',
      providerOrderId: 'order_1',
      amount: 49_000,
      currency: 'INR',
      orderNumber: 'FOS-24001',
      prefill: { name: 'Asha Rao', contact: null, email: null },
    });
    vi.spyOn(customer.payments, 'mockCheckout').mockResolvedValue({
      providerPaymentId: 'pay_x',
      signature: 'sig',
    });
    vi.spyOn(customer.payments, 'verify').mockResolvedValue({
      id: 'pay1',
      orderId: 'o1',
      method: 'ONLINE',
      provider: 'mock',
      amount: 49_000,
      currency: 'INR',
      status: 'FAILED',
      capturedAmount: 0,
      refundedAmount: 0,
      instrumentSummary: null,
      failureReason: 'Payment was declined by the bank',
      createdAt: '2026-11-21T06:30:00Z',
      capturedAt: null,
    });
    renderAt('/orders/o1/pay');
    fireEvent.click(await screen.findByRole('button', { name: 'Pay ₹490' }));
    expect(
      await screen.findByText('Payment was declined by the bank. You can try again.'),
    ).toBeInTheDocument();
  });

  it('tracks an order live: snapshot, then pushed status and location', async () => {
    vi.spyOn(customer.tracking, 'snapshot').mockResolvedValue(
      tracking({
        status: 'PREPARING',
        delivery: {
          status: 'ASSIGNED',
          assignedAt: null,
          arrivedRestaurantAt: null,
          pickedUpAt: null,
          arrivedCustomerAt: null,
          deliveredAt: null,
        },
        partner: { firstName: 'Ravi', vehicleType: 'SCOOTER', rating: 4.8 },
        location: {
          lat: 12.93,
          lng: 77.62,
          accuracyM: 8,
          recordedAt: new Date(Date.now() - 12_000).toISOString(),
          ageSeconds: 12,
          stale: false,
        },
        deliveryCode: '4821',
        live: true,
      }),
    );
    vi.spyOn(customer.orders, 'details').mockResolvedValue(details({ status: 'PREPARING' }));
    renderAt('/orders/o1');

    expect(await screen.findByRole('heading', { name: 'Preparing your food' })).toBeInTheDocument();
    expect(screen.getByText('Ravi')).toBeInTheDocument();
    expect(screen.getByText('Scooter · ★ 4.8')).toBeInTheDocument();
    expect(screen.getByText('4821')).toBeInTheDocument();
    expect(screen.getByText(/updated 1[2-3] s ago/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in maps' })).toHaveAttribute(
      'href',
      expect.stringContaining('mlat=12.93'),
    );
    expect(socket.subscribed).toContainEqual({ type: 'order', id: 'o1' });

    act(() =>
      socket.emit('order.status_changed', {
        orderId: 'o1',
        from: 'PREPARING',
        to: 'PICKED_UP',
        eta: null,
      }),
    );
    expect(await screen.findByRole('heading', { name: 'On the way' })).toBeInTheDocument();
    // Another order's event is ignored.
    act(() => socket.emit('order.status_changed', { orderId: 'o2', to: 'DELIVERED' }));
    expect(screen.getByRole('heading', { name: 'On the way' })).toBeInTheDocument();

    act(() =>
      socket.emit(
        'tracking.location',
        {
          lat: 12.95,
          lng: 77.64,
          heading: null,
          accuracy: 5,
          recordedAt: new Date().toISOString(),
          stale: false,
        },
        { type: 'delivery', id: 'd1' },
      ),
    );
    expect(await screen.findByText('12.95000, 77.64000')).toBeInTheDocument();
    expect(screen.getByText(/updated [0-1] s ago/)).toBeInTheDocument();
    act(() =>
      socket.emit(
        'tracking.eta',
        { etaMinutes: 9, distanceRemainingKm: 2.4 },
        { type: 'delivery', id: 'd1' },
      ),
    );
    expect(await screen.findByText('About 9 min away · 2.4 km')).toBeInTheDocument();
  });

  it('says “Location updating…” when the partner’s location is stale', async () => {
    vi.spyOn(customer.tracking, 'snapshot').mockResolvedValue(
      tracking({
        status: 'PICKED_UP',
        partner: { firstName: 'Ravi', vehicleType: null, rating: null },
        location: {
          lat: 12.93,
          lng: 77.62,
          accuracyM: null,
          recordedAt: new Date(Date.now() - 20_000).toISOString(),
          ageSeconds: 20,
          stale: false,
        },
        live: true,
      }),
    );
    vi.spyOn(customer.orders, 'details').mockResolvedValue(details({ status: 'PICKED_UP' }));
    renderAt('/orders/o1');
    expect(await screen.findByText(/updated 2[0-1] s ago/)).toBeInTheDocument();
    act(() =>
      socket.emit(
        'tracking.stale',
        { lastSeenAt: new Date().toISOString() },
        { type: 'delivery', id: 'd1' },
      ),
    );
    expect(await screen.findByText('Location updating…')).toBeInTheDocument();
  });

  it('previews the fee, then cancels an order', async () => {
    vi.spyOn(customer.tracking, 'snapshot').mockResolvedValue(tracking());
    vi.spyOn(customer.orders, 'details').mockResolvedValue(details());
    vi.spyOn(customer.orders, 'cancellationPreview').mockResolvedValue({
      orderId: 'o1',
      status: 'PLACED',
      allowed: true,
      quoteId: 'q1',
      fee: 0,
      refund: {
        amount: 49_000,
        toSource: 49_000,
        toWallet: 0,
        walletReleased: 0,
        expectation: 'Original method: 5–7 business days.',
      },
      freeUntil: null,
      reasons: ['CHANGED_MIND', 'ORDERED_BY_MISTAKE'],
    });
    const cancel = vi.spyOn(customer.orders, 'cancel').mockResolvedValue({
      order: { id: 'o1', status: 'CANCELLED' },
      cancellation: {
        fee: 0,
        refund: {
          amount: 49_000,
          toSource: 49_000,
          toWallet: 0,
          walletReleased: 0,
          status: 'PENDING',
        },
      },
    });
    renderAt('/orders/o1');

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this order?' });
    expect(within(dialog).getByText('Free')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'ORDERED_BY_MISTAKE' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(cancel.mock.calls[0]!.slice(0, 2)).toEqual([
      'o1',
      { quoteId: 'q1', reasonCode: 'ORDERED_BY_MISTAKE' },
    ]);
    expect(cancel.mock.calls[0]![2]).toMatch(UUID);
    expect(await screen.findByText('Order cancelled. ₹490 will be refunded.')).toBeInTheDocument();
  });

  it('keeps the cancellation confirmation once the order shows as cancelled', async () => {
    const snapshot = vi.spyOn(customer.tracking, 'snapshot').mockResolvedValue(tracking());
    vi.spyOn(customer.orders, 'details').mockResolvedValue(details());
    vi.spyOn(customer.orders, 'cancellationPreview').mockResolvedValue({
      orderId: 'o1',
      status: 'PLACED',
      allowed: true,
      quoteId: 'q1',
      fee: 0,
      refund: {
        amount: 49_000,
        toSource: 49_000,
        toWallet: 0,
        walletReleased: 0,
        expectation: 'Original method: 5–7 business days.',
      },
      freeUntil: null,
      reasons: ['CHANGED_MIND'],
    });
    vi.spyOn(customer.orders, 'cancel').mockImplementation(async () => {
      snapshot.mockResolvedValue(tracking({ status: 'CANCELLED' }));
      return {
        order: { id: 'o1', status: 'CANCELLED' },
        cancellation: {
          fee: 0,
          refund: {
            amount: 49_000,
            toSource: 49_000,
            toWallet: 0,
            walletReleased: 0,
            status: 'PENDING',
          },
        },
      };
    });
    renderAt('/orders/o1');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this order?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByText('This order was cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    expect(screen.getByText('Order cancelled. ₹490 will be refunded.')).toBeInTheDocument();
  });

  it('shows “Finding a delivery partner” as soon as the restaurant accepts', async () => {
    const pending = {
      status: 'PENDING',
      assignedAt: null,
      arrivedRestaurantAt: null,
      pickedUpAt: null,
      arrivedCustomerAt: null,
      deliveredAt: null,
    };
    const snapshot = vi
      .spyOn(customer.tracking, 'snapshot')
      .mockResolvedValue(tracking({ delivery: pending }));
    vi.spyOn(customer.orders, 'details').mockResolvedValue(details());
    renderAt('/orders/o1');
    expect(
      await screen.findByRole('heading', { name: 'Order placed — waiting for the restaurant' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Finding a delivery partner')).not.toBeInTheDocument();
    snapshot.mockResolvedValue(tracking({ status: 'ACCEPTED', delivery: pending }));
    act(() =>
      socket.emit('order.status_changed', { orderId: 'o1', from: 'PLACED', to: 'ACCEPTED' }),
    );
    expect(await screen.findByText('Finding a delivery partner')).toBeInTheDocument();
    act(() => socket.emit('delivery.status_changed', { orderId: 'o1', status: 'SEARCHING' }));
    expect(screen.getByText('Finding a delivery partner')).toBeInTheDocument();
  });

  it('renders a 404 page for unknown routes', async () => {
    renderAt('/no-such-page');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});
