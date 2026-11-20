import type { ApiClient } from './client';
import type { Problem } from './merchant-api';

/** Delivery-partner endpoints (API-DP, API-DPDEL, API-EARN). Amounts are paise. */

export type VehicleType = 'BICYCLE' | 'E_BIKE' | 'MOTORCYCLE' | 'SCOOTER';
export type PresenceState = 'OFFLINE' | 'ONLINE_IDLE' | 'OFFERED' | 'ON_DELIVERY' | 'PAUSED';
export type DeliveryStatus =
  | 'PENDING'
  | 'SEARCHING'
  | 'ASSIGNED'
  | 'AT_RESTAURANT'
  | 'EN_ROUTE_TO_CUSTOMER'
  | 'AT_CUSTOMER'
  | 'DELIVERED'
  | 'FAILED'
  | 'CANCELLED';

export interface PartnerApplication {
  id: string;
  status: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'REJECTED';
  accountStatus: string;
  editable: boolean;
  legalName: string | null;
  dateOfBirth: string | null;
  homeZone: { id: string; name: string } | null;
  photoFileId: string | null;
  panMasked: string | null;
  aadhaarMasked: string | null;
  emergencyContact: { name: string; relation: string; phone: string } | null;
  vehicles: {
    id: string;
    type: VehicleType;
    registrationNumber: string | null;
    status: string;
    isActive: boolean;
  }[];
  documents: {
    id: string;
    type: string;
    status: string;
    expiresOn: string | null;
    reviewerNote: string | null;
  }[];
  bank: { holderName: string; accountMasked: string; ifsc: string; status: string } | null;
  guidelines: { required: string; acknowledged: string | null };
  missing: Problem[];
  rejectedReason: string | null;
}

export interface Availability {
  state: PresenceState;
  offlineAfterCurrent: boolean;
  pausedUntil: string | null;
  activeDeliveryId: string | null;
  cashInHand: number;
  cashCap: number;
  blockers: Problem[];
}

export interface PartnerDashboard {
  onlineSeconds: number;
  deliveries: number;
  earnings: number;
  tips: number;
  activeDeliveryId: string | null;
  availability: Availability;
}

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
  recordedAt?: string;
  heading?: number;
  speedKmh?: number;
}

export type PaymentToCollect = { type: 'COD'; collect: number } | { type: 'PREPAID' };

export interface Offer {
  offerId: string;
  deliveryId: string;
  expiresAt: string;
  serverTime: string;
  restaurant: { name: string; branch: string; area: string; distanceKm: number };
  drop: { area: string | null; distanceKm: number | null };
  items: number;
  payment: PaymentToCollect;
}

export interface Point {
  lat: number;
  lng: number;
}

export interface ActiveDelivery {
  id: string;
  status: DeliveryStatus;
  orderNumber: string;
  orderStatus: string;
  pickupCode: string | null;
  restaurant: {
    name: string;
    branch: string;
    address: string;
    phone: string | null;
    location: Point | null;
  };
  items: number;
  customer: {
    name: string | null;
    address: string | null;
    instructions: string | null;
    location: Point | null;
  };
  payment: PaymentToCollect;
  proof: 'OTP' | 'PHOTO';
  distances: { pickupM: number | null; dropM: number | null };
  earning: { total: number; tip: number } | null;
  times: {
    assignedAt: string | null;
    arrivedRestaurantAt: string | null;
    pickedUpAt: string | null;
    deliveredAt: string | null;
  };
}

export interface DeliveryHistoryRow {
  id: string;
  orderNumber: string;
  restaurant: string;
  status: DeliveryStatus;
  date: string;
  distanceKm: number | null;
  earning: number;
}

export interface EarningsSummary {
  period: 'day' | 'week' | 'month';
  from: string;
  to: string;
  deliveries: number;
  cancelledTrips: number;
  distanceKm: number;
  breakdown: {
    base: number;
    distance: number;
    wait: number;
    surge: number;
    tips: number;
    incentives: number;
    adjustments: number;
  };
  tripPay: number;
  total: number;
  days: { date: string; deliveries: number; amount: number }[];
}

export interface EarningEntry {
  id: string;
  type: string;
  description: string;
  amount: number;
  deliveryId: string | null;
  orderNumber: string | null;
  createdAt: string;
}

export interface CashView {
  balance: number;
  cap: number;
  remaining: number;
  blocked: boolean;
  howToDeposit: string;
}

export interface NextPayout {
  periodStart: string;
  periodEnd: string;
  earnings: number;
  cashDeduction: number;
  amount: number;
  minimum: number;
  status: 'SCHEDULED' | 'BELOW_MINIMUM' | 'CARRY_OVER_NEGATIVE' | 'ON_HOLD_BANK_CHANGE';
}

export interface Payout {
  id: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  status: 'PENDING' | 'PAID' | 'FAILED';
  utr: string | null;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface Performance {
  windowDays: number;
  offers: number;
  acceptanceRate: number | null;
  deliveries: number;
  completionRate: number | null;
  onTimeRate: number | null;
  rating: number | null;
  ratingCount: number;
}

export interface PartnerRatings {
  average: number | null;
  count: number;
  distribution: Record<string, number>;
  tags: Record<string, number>;
  comments: string[];
}

export interface BankAccountView {
  id: string;
  holderName: string;
  accountMasked: string;
  ifsc: string;
  status: string;
  verifiedAt: string | null;
}

export interface BankDetails {
  current: BankAccountView | null;
  pendingChange: BankAccountView | null;
  payoutsOnHold: boolean;
}

export function createPartnerApi(client: ApiClient) {
  const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });
  const D = (id: string) => `/partner/deliveries/${id}`;
  return {
    upload: async (file: Blob, purpose: string, filename = 'upload') => {
      const form = new FormData();
      form.append('purpose', purpose);
      form.append('file', file, filename);
      const res = await client.http.post<{ data: { id: string } }>('/api/v1/files', form);
      return res.data.data;
    },
    zones: () => client.get<{ id: string; name: string; city: string }[]>('/partner/zones'),
    application: {
      start: () => client.post<PartnerApplication>('/partner/applications'),
      get: () => client.get<PartnerApplication>('/partner/applications/me'),
      update: (body: Record<string, unknown>) =>
        client.patch<PartnerApplication>('/partner/applications/me', body),
      addDocument: (body: {
        type: string;
        fileId: string;
        numberLast4?: string;
        expiresOn?: string;
      }) => client.post<PartnerApplication>('/partner/applications/me/documents', body),
      submit: () => client.post<PartnerApplication>('/partner/applications/me/submit'),
      acknowledgeGuidelines: (version: string) =>
        client.post('/partner/me/guidelines/ack', { version }),
    },
    /** API-DP-007…012: the approved partner's own profile and vehicles. */
    profile: {
      get: () => client.get<PartnerApplication>('/partner/me'),
      update: (body: {
        emergencyContact?: { name: string; relation: string; phone: string };
        homeZoneId?: string;
      }) => client.patch<PartnerApplication>('/partner/me', body),
      vehicles: () => client.get<PartnerApplication['vehicles']>('/partner/me/vehicles'),
      addVehicle: (body: { type: VehicleType; registrationNumber?: string | null }) =>
        client.post<PartnerApplication>('/partner/me/vehicles', body),
      activateVehicle: (id: string) =>
        client.post<PartnerApplication>(`/partner/me/vehicles/${id}/activate`),
    },
    availability: () => client.get<Availability>('/partner/me/availability'),
    dashboard: () => client.get<PartnerDashboard>('/partner/me/dashboard'),
    goOnline: (fix: Fix) => client.post<Availability>('/partner/me/online', fix, idem()),
    goOffline: () => client.post<Availability>('/partner/me/offline', {}, idem()),
    pause: (minutes: 15 | 30) => client.post<Availability>('/partner/me/pause', { minutes }),
    resume: () => client.post<Availability>('/partner/me/resume', {}),
    sendLocations: (points: Fix[]) => client.post('/partner/me/locations', { points }),
    offers: {
      current: () => client.get<Offer | null>('/partner/offers/current'),
      accept: (offerId: string) =>
        client.post<{ deliveryId: string; status: DeliveryStatus }>(
          `/partner/offers/${offerId}/accept`,
          {},
          idem(),
        ),
      reject: (offerId: string, reason?: 'TOO_FAR' | 'VEHICLE_ISSUE' | 'OTHER') =>
        client.post(`/partner/offers/${offerId}/reject`, reason ? { reason } : {}, idem()),
    },
    deliveries: {
      active: () => client.get<ActiveDelivery | null>('/partner/deliveries/active'),
      history: (params: { limit?: number; from?: string; to?: string } = {}) =>
        client.get<DeliveryHistoryRow[]>('/partner/deliveries', params),
      arrivedAtRestaurant: (id: string, body: { at?: Point; confirm?: boolean } = {}) =>
        client.post<ActiveDelivery>(`${D(id)}/arrived-at-restaurant`, body, idem()),
      pickedUp: (id: string, body: { at?: Point } = {}) =>
        client.post<ActiveDelivery>(`${D(id)}/picked-up`, body, idem()),
      arrivedAtCustomer: (id: string, body: { at?: Point; confirm?: boolean } = {}) =>
        client.post<ActiveDelivery>(`${D(id)}/arrived-at-customer`, body, idem()),
      complete: (
        id: string,
        body: {
          method: 'OTP' | 'PHOTO';
          otp?: string;
          photoFileId?: string;
          cashCollected?: boolean;
          at?: Point;
        },
      ) => client.post<ActiveDelivery>(`${D(id)}/complete`, body, idem()),
      customerUnreachable: (id: string, body: { callAttempts: number; note?: string }) =>
        client.post<ActiveDelivery>(`${D(id)}/customer-unreachable`, body, idem()),
      unassign: (
        id: string,
        body: { reason: 'ACCIDENT' | 'VEHICLE_BREAKDOWN' | 'EMERGENCY' | 'OTHER'; note?: string },
      ) => client.post(`${D(id)}/unassign`, body, idem()),
    },
    earnings: {
      summary: (period: 'day' | 'week' | 'month', date?: string) =>
        client.get<EarningsSummary>('/partner/me/earnings/summary', { period, date }),
      entries: (params: { cursor?: string; limit?: number } = {}) =>
        client.getPage<EarningEntry[]>('/partner/me/earnings', params),
      cash: () => client.get<CashView>('/partner/me/cash'),
      payouts: () => client.get<{ next: NextPayout; items: Payout[] }>('/partner/me/payouts'),
      performance: () => client.get<Performance>('/partner/me/performance'),
      ratings: () => client.get<PartnerRatings>('/partner/me/ratings'),
      bank: () => client.get<BankDetails>('/partner/me/bank-account'),
      changeBank: (body: { holderName: string; accountNumber: string; ifsc: string }) =>
        client.post<BankDetails>('/partner/me/bank-account/change-requests', body, idem()),
    },
  };
}

export type PartnerApi = ReturnType<typeof createPartnerApi>;
