import type {
  AddCartItemBody,
  CreateAddressBody,
  DiscoveryListQuery,
  SearchQuery,
  UpdateAddressBody,
} from '@fos/validation';
import type { ApiClient } from './client';

/* Response shapes of the Phase 5 customer APIs (SRS §14: API-GEO, ADDR, REST, MENU, DISC, SRCH, FAV, USER). */

export interface LatLng {
  lat: number;
  lng: number;
}
export type DietaryMarker = 'VEG' | 'NON_VEG' | 'EGG';
export type ServiceabilityReason =
  'OUTSIDE_ZONE' | 'OUTSIDE_RADIUS' | 'BRANCH_CLOSED' | 'BRANCH_PAUSED' | 'ZONE_SUSPENDED';

export interface GeoAddress extends LatLng {
  formatted: string;
  line2: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string | null;
}
export interface PlaceSuggestion {
  placeId: string;
  title: string;
  subtitle: string;
  distanceM: number | null;
}
export interface Eta {
  minMinutes: number;
  maxMinutes: number;
}
export interface DeliveryInfo {
  serviceable: boolean;
  reason: ServiceabilityReason | null;
  distanceKm: number;
  eta: Eta;
  deliveryFeeAmount: number;
  surge: { amount: number; reason: string | null };
  minOrderAmount: number;
  maxOrderAmount: number | null;
  smallOrderThresholdAmount: number;
  smallOrderFeeAmount: number;
  platformFeeAmount: number;
}
export interface Serviceability {
  serviceable: boolean;
  reason: ServiceabilityReason | null;
  zone: { id: string; name: string; city: string } | null;
  branch: DeliveryInfo | null;
}
export interface Rating {
  average: number | null;
  count: number;
  isNew: boolean;
}
export interface BranchStatus {
  state: 'OPEN' | 'CLOSING_SOON' | 'CLOSED' | 'PAUSED' | 'UNAVAILABLE';
  acceptingOrders: boolean;
  reason: string | null;
  opensAt: string | null;
  lastOrderAt: string | null;
}
export interface BranchCard {
  branchId: string;
  restaurantId: string;
  restaurantName: string;
  branchName: string;
  slug: string;
  area: string;
  logoUrl: string | null;
  coverUrl: string | null;
  cuisines: string[];
  rating: Rating;
  priceForTwoAmount: number | null;
  pureVeg: boolean;
  status: BranchStatus;
  delivery: Pick<
    DeliveryInfo,
    'serviceable' | 'reason' | 'distanceKm' | 'eta' | 'deliveryFeeAmount' | 'surge'
  > | null;
  bestOffer: string | null;
  isFavorite: boolean;
}
export interface WeeklyHours {
  timezone: string;
  today: { weekday: number; name: string; slots: { opensAt: string; closesAt: string }[] };
  week: { weekday: number; name: string; slots: { opensAt: string; closesAt: string }[] }[];
  upcomingHolidays: { startsAt: string; endsAt: string; reason: string | null }[];
}
export interface BranchPage extends BranchCard {
  description: string | null;
  address: {
    line1: string;
    line2: string | null;
    area: string;
    city: string;
    state: string;
    pincode: string;
  };
  location: LatLng;
  fssaiNumber: string | null;
  minOrderAmount: number;
  maxOrderAmount: number | null;
  hours: WeeklyHours;
  offers: unknown[];
  deliveryDetails: DeliveryInfo | null;
}
export interface ItemCard {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  priceAmount: number;
  originalPriceAmount: number | null;
  dietaryMarker: DietaryMarker;
  tags: string[];
  spiceLevel: number | null;
  isBestseller: boolean;
  isRecommended: boolean;
  isTodaysSpecial: boolean;
  customizable: boolean;
  available: boolean;
  unavailableReason: 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'BRANCH_CLOSED' | null;
  availableAt: string | null;
}
export interface Menu {
  branchId: string;
  menuVersion: number;
  vegOnly: boolean;
  sections: { key: string; title: string; itemIds: string[] }[];
  categories: { id: string; name: string; description: string | null; items: ItemCard[] }[];
}
export interface ItemDetails extends ItemCard {
  images: string[];
  servingSize: string | null;
  prepMinutes: number | null;
  ingredients: string[];
  allergens: string[];
  allergenWarnings: string[];
  variants: { id: string; name: string; priceAmount: number; isDefault: boolean }[];
  customizationGroups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    required: boolean;
    variantId: string | null;
    options: {
      id: string;
      name: string;
      priceDeltaAmount: number;
      dietaryMarker: DietaryMarker;
      isDefault: boolean;
      available: boolean;
    }[];
  }[];
}
export interface DishResult {
  item: ItemCard;
  branch: { branchId: string; restaurantName: string; eta: Eta };
}
export interface HomeFeed {
  zone: { id: string; name: string };
  banners: { id: string; title: string; imageUrl: string | null; targetRoute: string }[];
  cuisines: { slug: string; name: string; restaurantCount: number }[];
  sections: (
    | { key: string; title: string; type: 'restaurants'; restaurants: BranchCard[] }
    | { key: string; title: string; type: 'items'; items: DishResult[] }
  )[];
  orderAgain: BranchCard[];
}
export interface SearchResults {
  restaurants: BranchCard[];
  dishes: DishResult[];
  cuisines: { slug: string; name: string; restaurantCount: number }[];
}
export interface Address {
  id: string;
  label: 'HOME' | 'WORK' | 'OTHER';
  customLabel: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string;
  location: LatLng;
  contactName: string;
  contactPhone: string;
  instructions: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  serviceability?: {
    serviceable: boolean;
    reason: ServiceabilityReason | null;
    distanceKm: number | null;
  };
}
export interface Preferences {
  vegOnlyDefault: boolean;
  dietaryTags: string[];
  allergens: string[];
}

/* Phase 6–9 customer APIs: cart, coupons, checkout, payments, orders and tracking (SRS §14). */

export type CartLineStatus =
  | 'OK'
  | 'PRICE_CHANGED'
  | 'ITEM_REMOVED'
  | 'ITEM_UNAVAILABLE'
  | 'VARIANT_UNAVAILABLE'
  | 'OPTION_UNAVAILABLE'
  | 'CUSTOMIZATION_INVALID'
  | (string & {});
export interface CartIssue {
  code: string;
  message: string;
  lineId?: string;
}
export interface CartLine {
  id: string;
  foodItemId: string;
  name: string;
  dietaryMarker: DietaryMarker | null;
  variant: { id: string; name: string } | null;
  options: { id: string; name: string; groupName: string }[];
  quantity: number;
  instructions: string | null;
  unitAmount: number | null;
  lineAmount: number | null;
  /** BR-CART-005: flagged, never silently dropped or repriced. */
  status: CartLineStatus;
  previousUnitAmount: number | null;
  message: string | null;
}
/** The server's price quote (FR-PRICE-001); every amount in paise. */
export interface PriceQuote {
  pricingVersion: number;
  feeScheduleId: string;
  lines: {
    lineId: string;
    unitAmount: number;
    quantity: number;
    lineAmount: number;
    itemDiscountAmount: number;
  }[];
  itemsSubtotal: number;
  itemDiscountTotal: number;
  discounts: {
    source: 'PROMOTION' | 'COUPON';
    id: string;
    label: string;
    amount: number;
    freeDelivery: boolean;
  }[];
  couponNotice: string | null;
  couponShortfall: number | null;
  packagingFee: number;
  deliveryFee: number;
  deliveryFeeWaived: number;
  deliveryFeeKnown: boolean;
  surgeFee: number;
  surgeReason: string | null;
  smallOrderFee: number;
  platformFee: number;
  taxes: { taxCode: string; component: string; rateBps: number; amount: number }[];
  taxTotal: number;
  tip: number;
  total: number;
  walletApplied: number;
  payable: number;
}
export interface Cart {
  id: string | null;
  version: number;
  branch: {
    id: string;
    restaurantId: string;
    restaurantName: string;
    branchName: string;
    acceptingOrders: boolean;
    minOrderAmount: number;
  } | null;
  lines: CartLine[];
  itemCount: number;
  instructions: string | null;
  noCutlery: boolean;
  coupon: { id: string; code: string } | null;
  preview: PriceQuote | null;
  delivery: Pick<DeliveryInfo, 'serviceable' | 'reason' | 'distanceKm' | 'eta'> | null;
  blocking: CartIssue[];
  warnings: CartIssue[];
}
export interface CouponOffer {
  code: string;
  description: string | null;
  discountType: string;
  eligible: boolean;
  reason: string | null;
}
export type PaymentMethodKind = 'ONLINE' | 'COD' | 'WALLET';
export interface PaymentMethodOption {
  method: PaymentMethodKind;
  available: boolean;
  reason: string | null;
  balance?: number;
}
export interface CheckoutOptionsBody {
  addressId: string;
  paymentMethod: PaymentMethodKind;
  useWallet?: boolean;
  tipAmount?: number;
  deliveryInstructions?: string;
  contactless?: boolean;
  contactName?: string;
  contactPhone?: string;
}
export interface CheckoutSession {
  id: string;
  status: 'OPEN' | 'CONFIRMED' | 'EXPIRED';
  version: number;
  expiresAt: string;
  branchId: string;
  address: Omit<Address, 'createdAt' | 'updatedAt' | 'serviceability'>;
  paymentMethod: PaymentMethodKind;
  useWallet: boolean;
  tipAmount: number;
  deliveryInstructions: string | null;
  contactless: boolean;
  contact: { name: string | null; phone: string | null };
  delivery: { distanceKm: number; eta: Eta } | null;
  quote: PriceQuote;
  payableAmount: number;
}
export type CustomerOrderStatus =
  | 'PAYMENT_PENDING'
  | 'PLACED'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'PICKED_UP'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'FAILED';
/** Public parameters for the provider's checkout (API-PAY-002); never a secret. */
export interface PaymentInit {
  paymentId: string;
  provider: string;
  keyId: string;
  providerOrderId: string;
  amount: number;
  currency: string;
  orderNumber: string;
  prefill: { name: string | null; contact: string | null; email: string | null };
}
export interface OrderConfirmation {
  order: {
    id: string;
    number: string;
    status: CustomerOrderStatus;
    payableAmount: number;
    paymentMethod: PaymentMethodKind;
  };
  payment: PaymentInit | null;
  paymentError: string | null;
}
export interface CustomerPayment {
  id: string;
  orderId: string;
  method: string;
  provider: string;
  amount: number;
  currency: string;
  status: 'CREATED' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | (string & {});
  capturedAmount: number;
  refundedAmount: number;
  instrumentSummary: string | null;
  failureReason: string | null;
  createdAt: string;
  capturedAt: string | null;
}
export interface OrderTimelineEntry {
  status: CustomerOrderStatus;
  label: string;
  at: string;
  by: string;
}
export interface CustomerOrderSummary {
  id: string;
  number: string;
  status: CustomerOrderStatus;
  statusLabel: string;
  restaurant: {
    id: string;
    name: string;
    logoFileId: string | null;
    branchId: string;
    branchName: string;
  };
  itemsSummary: string;
  itemCount: number;
  totalAmount: number;
  paymentMethod: PaymentMethodKind;
  refundStatus: string | null;
  createdAt: string;
  placedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  eta: { minAt: string; maxAt: string } | null;
}
export interface CustomerOrderDetails extends CustomerOrderSummary {
  version: number;
  items: {
    id: string;
    foodItemId: string;
    itemName: string;
    variantName: string | null;
    dietaryMarker: DietaryMarker | null;
    unitPriceAmount: number;
    optionsAmount: number;
    itemDiscountAmount: number;
    quantity: number;
    lineTotalAmount: number;
    instructions: string | null;
    options: { groupName: string; optionName: string; priceDeltaAmount: number }[];
  }[];
  breakdown: {
    components: { type: string; label: string; amount: number; code: string | null }[];
    itemsSubtotal: number;
    discountTotal: number;
    taxTotal: number;
    tip: number;
    walletApplied: number;
    total: number;
    payable: number;
  };
  address: {
    line1: string;
    line2: string | null;
    landmark: string | null;
    area: string;
    city: string;
    state: string;
    pincode: string;
  } | null;
  contact: { name: string | null; phone: string | null };
  deliveryInstructions: string | null;
  cookingInstructions: string | null;
  payments: {
    id: string;
    method: string;
    status: string;
    amount: number;
    capturedAmount: number;
    refundedAmount: number;
    instrumentSummary: string | null;
  }[];
  refunds: {
    id: string;
    amount: number;
    destination: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
  }[];
  cancellation: {
    reasonCode: string;
    feeAmount: number;
    refundAmount: number;
    createdAt: string;
  } | null;
  timeline: OrderTimelineEntry[];
  invoiceAvailable: boolean;
  reviewed: boolean;
}
export interface TrackingLocation {
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: string;
  ageSeconds: number;
  /** FR-TRK-005: no fix for over a minute ("Location updating…"). */
  stale: boolean;
}
export interface PartnerCard {
  firstName: string;
  vehicleType: string | null;
  rating: number | null;
}
/** API-TRK-001 snapshot. */
export interface OrderTracking {
  orderId: string;
  number: string;
  status: CustomerOrderStatus;
  eta: { minAt: string; maxAt: string } | null;
  restaurant: { name: string; lat: number | null; lng: number | null };
  destination: LatLng | null;
  delivery: {
    status: string;
    assignedAt: string | null;
    arrivedRestaurantAt: string | null;
    pickedUpAt: string | null;
    arrivedCustomerAt: string | null;
    deliveredAt: string | null;
  } | null;
  partner: PartnerCard | null;
  location: TrackingLocation | null;
  route: null;
  deliveryCode: string | null;
  live: boolean;
}
export type CancelReasonCode =
  'CHANGED_MIND' | 'ORDERED_BY_MISTAKE' | 'DELAY' | 'ADDRESS_ISSUE' | 'PAYMENT_ISSUE' | 'OTHER';
export interface CancellationPreview {
  orderId: string;
  status: CustomerOrderStatus;
  allowed: boolean;
  reason?: string;
  supportLink?: string;
  quoteId: string | null;
  fee: number;
  refund: {
    amount: number;
    toSource: number;
    toWallet: number;
    walletReleased: number;
    expectation: string;
  };
  freeUntil: string | null;
  reasons: CancelReasonCode[];
}
export interface CancellationResult {
  order: { id: string; status: 'CANCELLED' };
  cancellation: {
    fee: number;
    refund: {
      amount: number;
      toSource: number;
      toWallet: number;
      walletReleased: number;
      status: 'PENDING' | 'NONE';
    };
  };
}
export type MockPaymentScenario = 'success' | 'fail' | 'authorize_only' | 'amount_mismatch';

type Query = Record<string, string | number | boolean | undefined>;
/** Header for endpoints guarded by `idempotent(...)` (FR-ORDER-002, FR-PAY-007). */
const once = (key: string) => ({ 'Idempotency-Key': key });
/** Where to price delivery: a saved address or a point (FR-CART-008). */
export type CartPricingPoint = { addressId: string } | LatLng | null;
const pricing = (at: CartPricingPoint | undefined, tip?: number): Query => ({
  ...(at ? at : {}),
  ...(tip ? { tip } : {}),
});
const withLocation = (point: LatLng, extra: Query = {}) => ({
  lat: point.lat,
  lng: point.lng,
  ...extra,
});
/** Query strings carry comma-separated lists. */
const listQuery = (q: Partial<DiscoveryListQuery>): Query => ({
  ...q,
  cuisines: q.cuisines?.join(','),
  // The API takes the rating floor as text ("4.0"), not the parsed number.
  minRating: q.minRating?.toFixed(1),
});

/** Typed wrappers for the customer app (Phase 5 APIs). */
export function createCustomerApi(client: ApiClient) {
  return {
    geo: {
      autocomplete: (q: string, bias?: LatLng, sessionToken?: string) =>
        client.get<PlaceSuggestion[]>('/geo/autocomplete', { q, ...(bias ?? {}), sessionToken }),
      place: (placeId: string) =>
        client.get<GeoAddress>(`/geo/places/${encodeURIComponent(placeId)}`),
      reverse: (point: LatLng) =>
        client.get<{ address: GeoAddress | null; degraded: boolean }>(
          '/geo/reverse',
          withLocation(point),
        ),
      serviceability: (point: LatLng, branchId?: string) =>
        client.get<Serviceability>('/geo/serviceability', withLocation(point, { branchId })),
    },
    profile: {
      update: (body: { fullName?: string; locale?: string }) => client.patch('/me', body),
      preferences: () => client.get<Preferences>('/me/preferences'),
      updatePreferences: (body: Partial<Preferences>) =>
        client.patch<Preferences>('/me/preferences', body),
    },
    addresses: {
      list: (branchId?: string) => client.get<Address[]>('/me/addresses', { branchId }),
      create: (body: CreateAddressBody) => client.post<Address>('/me/addresses', body),
      update: (id: string, body: UpdateAddressBody) =>
        client.patch<Address>(`/me/addresses/${id}`, body),
      remove: (id: string) => client.delete<null>(`/me/addresses/${id}`),
      setDefault: (id: string) => client.post<Address>(`/me/addresses/${id}/default`),
    },
    discovery: {
      home: (point: LatLng, vegOnly?: boolean) =>
        client.get<HomeFeed>('/discovery/home', withLocation(point, { vegOnly })),
      restaurants: (point: LatLng, q: Partial<Omit<DiscoveryListQuery, 'lat' | 'lng'>> = {}) =>
        client.getPage<BranchCard[]>('/discovery/restaurants', withLocation(point, listQuery(q))),
      collection: (slug: string, point: LatLng, cursor?: string) =>
        client.getPage<{ slug: string; title: string; restaurants: BranchCard[] }>(
          `/discovery/collections/${slug}`,
          withLocation(point, { cursor }),
        ),
      cuisines: (point: LatLng) =>
        client.get<{ slug: string; name: string; restaurantCount: number }[]>(
          '/discovery/cuisines',
          withLocation(point),
        ),
    },
    branches: {
      page: (branchId: string, point?: LatLng) =>
        client.get<BranchPage>(`/branches/${branchId}`, point ? withLocation(point) : {}),
      deliveryInfo: (branchId: string, point: LatLng) =>
        client.get<DeliveryInfo>(`/branches/${branchId}/delivery-info`, withLocation(point)),
      menu: (branchId: string, vegOnly?: boolean) =>
        client.get<Menu>(`/branches/${branchId}/menu`, { vegOnly }),
      item: (branchId: string, itemId: string) =>
        client.get<ItemDetails>(`/branches/${branchId}/menu/items/${itemId}`),
    },
    search: {
      query: (q: SearchQuery) => client.getPage<SearchResults>('/search', q as unknown as Query),
      suggestions: (q: string, point: LatLng) =>
        client.get<
          (
            | { type: 'restaurant'; text: string; branchId: string }
            | { type: 'cuisine'; text: string; slug: string }
            | { type: 'dish'; text: string }
          )[]
        >('/search/suggestions', withLocation(point, { q })),
      history: () =>
        client.get<{ id: string; query: string; createdAt: string }[]>('/me/search-history'),
      clearHistory: () => client.delete<null>('/me/search-history'),
    },
    favorites: {
      restaurants: (point?: LatLng) =>
        client.get<{ restaurantId: string; serviceable: boolean; card: BranchCard | null }[]>(
          '/me/favorites/restaurants',
          point ? withLocation(point) : {},
        ),
      addRestaurant: (restaurantId: string) =>
        client.put<null>(`/me/favorites/restaurants/${restaurantId}`),
      removeRestaurant: (restaurantId: string) =>
        client.delete<null>(`/me/favorites/restaurants/${restaurantId}`),
      addItem: (itemId: string) => client.put<null>(`/me/favorites/items/${itemId}`),
      removeItem: (itemId: string) => client.delete<null>(`/me/favorites/items/${itemId}`),
    },
    cart: {
      get: (at?: CartPricingPoint, tip?: number) => client.get<Cart>('/cart', pricing(at, tip)),
      add: (
        body: Omit<AddCartItemBody, 'optionIds' | 'replaceCart'> & {
          optionIds?: string[];
          replaceCart?: boolean;
        },
      ) => client.post<Cart>('/cart/items', body),
      setQuantity: (lineId: string, quantity: number, version?: number) =>
        client.patch<Cart>(`/cart/items/${lineId}`, { quantity, version }),
      removeLine: (lineId: string) => client.delete<Cart>(`/cart/items/${lineId}`),
      clear: () => client.delete<Cart>('/cart'),
      applyCoupon: (code: string) =>
        client.post<{
          cart: Cart;
          coupon: { code: string; discountAmount: number; freeDelivery: boolean };
        }>('/cart/coupon', { code }),
      removeCoupon: () => client.delete<Cart>('/cart/coupon'),
    },
    coupons: {
      list: (branchId: string) => client.get<CouponOffer[]>('/coupons', { branchId }),
    },
    checkout: {
      methods: (branchId: string, amount: number) =>
        client.get<PaymentMethodOption[]>('/payments/methods', { branchId, amount }),
      create: (body: CheckoutOptionsBody) =>
        client.post<CheckoutSession>('/checkout/sessions', body),
      get: (sessionId: string) => client.get<CheckoutSession>(`/checkout/sessions/${sessionId}`),
      update: (sessionId: string, body: Partial<CheckoutOptionsBody> & { version?: number }) =>
        client.patch<CheckoutSession>(`/checkout/sessions/${sessionId}`, body),
      /** API-CHK-004: never charges an amount the customer didn't see (PRICE_CHANGED otherwise). */
      confirm: (sessionId: string, expectedPayable: number, idempotencyKey: string) =>
        client.post<OrderConfirmation>(
          `/checkout/sessions/${sessionId}/confirm`,
          { expectedPayable },
          once(idempotencyKey),
        ),
    },
    payments: {
      initiate: (orderId: string, idempotencyKey: string) =>
        client.post<PaymentInit>(`/orders/${orderId}/payments`, undefined, once(idempotencyKey)),
      get: (paymentId: string) => client.get<CustomerPayment>(`/payments/${paymentId}`),
      verify: (
        paymentId: string,
        body: { providerPaymentId: string; signature: string },
        idempotencyKey: string,
      ) =>
        client.post<CustomerPayment>(`/payments/${paymentId}/verify`, body, once(idempotencyKey)),
      /** Development only: the mock provider's stand-in for the hosted checkout. */
      mockCheckout: (paymentId: string, scenario: MockPaymentScenario = 'success') =>
        client.post<{ providerPaymentId: string; signature: string }>(
          `/payments/${paymentId}/mock-checkout`,
          { scenario },
        ),
      /** API-PAY-005: abandon an unpaid order. */
      cancel: (paymentId: string, idempotencyKey: string) =>
        client.post<unknown>(`/payments/${paymentId}/cancel`, undefined, once(idempotencyKey)),
    },
    orders: {
      active: () => client.get<CustomerOrderSummary[]>('/me/orders/active'),
      details: (orderId: string) => client.get<CustomerOrderDetails>(`/orders/${orderId}`),
      timeline: (orderId: string) =>
        client.get<OrderTimelineEntry[]>(`/orders/${orderId}/timeline`),
      cancellationPreview: (orderId: string) =>
        client.get<CancellationPreview>(`/orders/${orderId}/cancellation-preview`),
      cancel: (
        orderId: string,
        body: { quoteId: string; reasonCode: CancelReasonCode; note?: string },
        idempotencyKey: string,
      ) => client.post<CancellationResult>(`/orders/${orderId}/cancel`, body, once(idempotencyKey)),
    },
    tracking: {
      snapshot: (orderId: string) => client.get<OrderTracking>(`/orders/${orderId}/tracking`),
      /** API-TRK-002 poll fallback (at most every 5 s). */
      location: (orderId: string) =>
        client.get<{ status: string | null; location: TrackingLocation | null }>(
          `/orders/${orderId}/tracking/location`,
        ),
    },
  };
}

export type CustomerApi = ReturnType<typeof createCustomerApi>;
