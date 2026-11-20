import type { ApiClient } from './client';
import type { DietaryMarker } from './customer-api';

/* Response shapes of the Phase 8 restaurant (merchant) APIs: API-MER, RMENU, RORD, RSTAFF, RANL, FILE. */

export type RestaurantRole = 'OWNER' | 'MANAGER' | 'ORDER_MANAGER' | 'KITCHEN' | 'STAFF';
export type OnboardingStatus =
  'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'REJECTED';

export interface MerchantMe {
  scope: 'FULL' | 'ONBOARDING';
  restaurants: {
    id: string;
    name: string;
    role: RestaurantRole;
    permissions: string[];
    branches: { id: string; name: string; area: string; status: string }[];
  }[];
  applications: {
    id: string;
    brandName: string;
    onboardingStatus: OnboardingStatus;
    updatedAt: string;
  }[];
}

export interface Slot {
  weekday: number;
  opensAt: string;
  closesAt: string;
}
export interface FileUrls {
  original: string;
  thumb?: string;
  card?: string;
  hero?: string;
}
export interface UploadedFile {
  id: string;
  purpose: string;
  mimeType: string;
  urls: FileUrls | null;
}
export interface Problem {
  path: string;
  code: string;
  message: string;
}

export interface Application {
  id: string;
  status: OnboardingStatus;
  editable: boolean;
  submissionCount: number;
  brandName: string;
  legalName: string;
  entityType: string;
  panMasked: string | null;
  gstin: string | null;
  fssaiNumber: string | null;
  fssaiExpiresOn: string | null;
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  pureVeg: boolean;
  cuisines: { id: string; name: string }[];
  logo: { fileId: string; urls: FileUrls | null } | null;
  branch: {
    name: string;
    line1: string;
    line2: string | null;
    area: string;
    city: string;
    state: string;
    pincode: string;
    location: { lat: number; lng: number } | null;
    deliveryRadiusM: number;
    defaultPrepMinutes: number;
    priceForTwo: number | null;
    hours: Slot[];
  } | null;
  bank: { holderName: string; accountMasked: string; ifsc: string; status: string } | null;
  documents: {
    id: string;
    type: string;
    fileId: string;
    status: string;
    reviewerNote: string | null;
  }[];
  missing: Problem[];
  review: { decision: string; comments: Record<string, string>; at: string } | null;
  rejectedReason: string | null;
}

export interface BranchStatusView {
  state: 'OPEN' | 'CLOSING_SOON' | 'CLOSED' | 'PAUSED' | 'UNAVAILABLE';
  acceptingOrders: boolean;
  reason: string | null;
  label: string;
  opensAt: string | null;
  online: boolean;
  pausedUntil: string | null;
  rush: { extraMinutes: number; until: string } | null;
}
export interface BranchSettings {
  id: string;
  name: string;
  deliveryRadiusM: number;
  minOrderAmount: number;
  maxOrderAmount: number | null;
  packagingFeeMode: 'NONE' | 'PER_ITEM' | 'PER_ORDER';
  packagingFeeAmount: number;
  defaultPrepMinutes: number;
  hours: Slot[];
  holidays: { id: string; startsAt: string; endsAt: string; reason: string | null }[];
  zone: { name: string; maxDeliveryRadiusM: number };
}

export type QueueTab = 'NEW' | 'PREPARING' | 'READY' | 'PICKED_UP' | 'COMPLETED' | 'CANCELLED';
export interface OrderCard {
  id: string;
  number: string;
  status: string;
  placedAt: string;
  acceptedAt: string | null;
  readyBy: string | null;
  prepMinutes: number | null;
  customer: string;
  area: string | null;
  payment: 'COD' | 'PAID' | 'PENDING';
  itemCount: number;
  items: {
    name: string;
    variant: string | null;
    quantity: number;
    options: string[];
    instructions: string | null;
  }[];
  cookingInstructions: string | null;
  acceptBy: string | null;
}
export interface OrderDetails extends OrderCard {
  version: number;
  value: { restaurantShare: number; commission: number; itemsSubtotal: number } | null;
  timeline: { status: string; at: string; by: string }[];
}
export interface KdsTicket {
  id: string;
  number: string;
  status: 'ACCEPTED' | 'PREPARING' | 'READY_FOR_PICKUP';
  acceptedAt: string | null;
  readyBy: string | null;
  elapsedSeconds: number;
  urgency: 'GREEN' | 'AMBER' | 'RED';
  items: OrderCard['items'];
  cookingInstructions: string | null;
}

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  basePriceAmount: number;
  discountedPriceAmount: number | null;
  dietaryMarker: DietaryMarker;
  isHidden: boolean;
  isBestseller: boolean;
  images: { id: string; fileId: string; urls: FileUrls | null }[];
  variants: { id: string; name: string; priceAmount: number; isDefault: boolean }[];
  version: number;
  available?: boolean;
  unavailableUntil?: string | null;
}
export interface ManagedMenu {
  categories: {
    id: string;
    name: string;
    description: string | null;
    isActive: boolean;
    items: MenuItem[];
  }[];
  customizationGroups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    options: {
      id: string;
      name: string;
      priceDeltaAmount: number;
      dietaryMarker: DietaryMarker;
      available?: boolean;
    }[];
  }[];
}

export interface Member {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  role: RestaurantRole;
  status: 'ACTIVE' | 'SUSPENDED';
  allBranches: boolean;
  branches: { id: string; name: string }[];
}
export interface Invitation {
  id: string;
  phone: string | null;
  email: string | null;
  role: RestaurantRole;
  status: string;
  expiresAt: string;
}
export interface Dashboard {
  orders: Record<
    'new' | 'preparing' | 'ready' | 'pickedUp' | 'delivered' | 'cancelled' | 'rejected',
    number
  >;
  revenue: { foodValue: number; deliveredValue: number; netPayable: number };
  averageOrderValue: number | null;
  acceptanceRate: number | null;
  avgAcceptSeconds: number | null;
  avgPrepSeconds: number | null;
  rating: { average: number; count: number } | null;
}

/** Typed wrappers for the restaurant app (SRS §14 merchant APIs). */
export function createMerchantApi(client: ApiClient) {
  const R = (rid: string) => `/merchant/restaurants/${rid}`;
  const B = (bid: string) => `/merchant/branches/${bid}`;
  const O = (oid: string) => `/merchant/orders/${oid}`;
  const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });
  return {
    me: () => client.get<MerchantMe>('/merchant/me'),
    cuisines: () => client.get<{ id: string; name: string }[]>('/merchant/cuisines'),
    /** API-FILE-001: multipart upload; returns the file id to attach elsewhere. */
    upload: async (file: Blob, purpose: string, filename = 'upload') => {
      const form = new FormData();
      form.append('purpose', purpose);
      form.append('file', file, filename);
      const res = await client.http.post<{ data: UploadedFile }>('/api/v1/files', form);
      return res.data.data;
    },
    applications: {
      start: (body: { brandName: string; legalName: string; entityType: string }) =>
        client.post<Application>('/merchant/applications', body),
      get: (id: string) => client.get<Application>(`/merchant/applications/${id}`),
      update: (id: string, body: Record<string, unknown>) =>
        client.patch<Application>(`/merchant/applications/${id}`, body),
      addDocument: (id: string, body: { type: string; fileId: string }) =>
        client.post(`/merchant/applications/${id}/documents`, body),
      submit: (id: string, declareNoGst: boolean) =>
        client.post<Application>(`/merchant/applications/${id}/submit`, { declareNoGst }),
    },
    branch: {
      status: (bid: string) => client.get<BranchStatusView>(`${B(bid)}/status`),
      settings: (bid: string) => client.get<BranchSettings>(B(bid)),
      update: (bid: string, body: Partial<BranchSettings>) =>
        client.patch<BranchSettings>(B(bid), body),
      hours: (bid: string, hours: Slot[]) =>
        client.put<BranchSettings>(`${B(bid)}/hours`, { hours }),
      addHoliday: (bid: string, body: { startsAt: string; endsAt: string; reason?: string }) =>
        client.post(`${B(bid)}/holidays`, body),
      removeHoliday: (bid: string, hid: string) => client.delete(`${B(bid)}/holidays/${hid}`),
      goLive: (bid: string) =>
        client.get<{ ready: boolean; missing: Problem[] }>(`${B(bid)}/go-live`),
      open: (bid: string) => client.post<BranchStatusView>(`${B(bid)}/open`),
      close: (bid: string) => client.post<BranchStatusView>(`${B(bid)}/close`, {}),
      pause: (bid: string, body: { minutes?: number; reason: string }) =>
        client.post<BranchStatusView>(`${B(bid)}/pause`, body),
      resume: (bid: string) => client.post<BranchStatusView>(`${B(bid)}/resume`),
      prepTime: (
        bid: string,
        body: { defaultPrepMinutes?: number; rush?: { extraMinutes: number; forMinutes: number } },
      ) => client.patch<BranchStatusView>(`${B(bid)}/prep-time`, body),
    },
    orders: {
      queue: (bid: string, status?: QueueTab) =>
        client.get<OrderCard[]>(`${B(bid)}/orders`, { status, limit: 50 }),
      counts: (bid: string) => client.get<Record<QueueTab, number>>(`${B(bid)}/orders/counts`),
      kds: (bid: string) => client.get<KdsTicket[]>(`${B(bid)}/kds`),
      get: (oid: string) => client.get<OrderDetails>(O(oid)),
      accept: (oid: string, prepMinutes?: number) =>
        client.post<OrderDetails>(`${O(oid)}/accept`, { prepMinutes }, idem()),
      reject: (
        oid: string,
        body: { reason: string; note?: string; itemIds?: string[]; markUnavailable?: boolean },
      ) => client.post<OrderDetails>(`${O(oid)}/reject`, body, idem()),
      preparing: (oid: string) => client.post<OrderDetails>(`${O(oid)}/preparing`, {}, idem()),
      ready: (oid: string) => client.post<OrderDetails>(`${O(oid)}/ready`, {}, idem()),
      extendPrep: (oid: string, minutes: number, reason: string) =>
        client.post<OrderDetails>(`${O(oid)}/prep-time`, { minutes, reason }, idem()),
      cancel: (oid: string, reason: string, note: string) =>
        client.post<OrderDetails>(`${O(oid)}/cancel`, { reason, note, confirm: true }, idem()),
    },
    menu: {
      get: (rid: string, branchId?: string) =>
        client.get<ManagedMenu>(`${R(rid)}/menu`, { branchId }),
      createCategory: (rid: string, name: string) => client.post(`${R(rid)}/categories`, { name }),
      updateCategory: (rid: string, cid: string, body: { name?: string; isActive?: boolean }) =>
        client.patch(`${R(rid)}/categories/${cid}`, body),
      createItem: (rid: string, body: Record<string, unknown>) =>
        client.post<MenuItem>(`${R(rid)}/items`, body),
      updateItem: (rid: string, iid: string, body: Record<string, unknown>) =>
        client.patch<MenuItem>(`${R(rid)}/items/${iid}`, body),
      deleteItem: (rid: string, iid: string) => client.delete(`${R(rid)}/items/${iid}`),
      addImage: (rid: string, iid: string, fileId: string) =>
        client.post<MenuItem>(`${R(rid)}/items/${iid}/images`, { fileId }),
      setAvailability: (bid: string, iid: string, available: boolean, until?: 'END_OF_DAY') =>
        client.put(`${B(bid)}/items/${iid}/availability`, {
          available,
          ...(until ? { until } : {}),
        }),
    },
    staff: {
      members: (rid: string) => client.get<Member[]>(`${R(rid)}/members`),
      invitations: (rid: string) => client.get<Invitation[]>(`${R(rid)}/invitations`),
      invite: (
        rid: string,
        body: {
          phone?: string;
          email?: string;
          role: RestaurantRole;
          allBranches: boolean;
          branchIds?: string[];
        },
      ) => client.post<Invitation>(`${R(rid)}/invitations`, body),
      revoke: (rid: string, id: string) => client.delete(`${R(rid)}/invitations/${id}`),
      update: (
        rid: string,
        mid: string,
        body: { role?: RestaurantRole; status?: 'ACTIVE' | 'SUSPENDED' },
      ) => client.patch<Member>(`${R(rid)}/members/${mid}`, body),
      remove: (rid: string, mid: string) => client.delete(`${R(rid)}/members/${mid}`),
      preview: (token: string) =>
        client.get<{
          restaurant: string;
          role: RestaurantRole;
          branches: string[];
          invitedBy: string;
          expiresAt: string;
        }>(`/merchant/invitations/${token}`),
      accept: (token: string) =>
        client.post<{ restaurantId: string; restaurant: string; role: RestaurantRole }>(
          `/merchant/invitations/${token}/accept`,
        ),
    },
    dashboard: (rid: string, branchIds?: string[]) =>
      client.get<Dashboard>(
        `${R(rid)}/dashboard`,
        branchIds ? { branchIds: branchIds.join(',') } : {},
      ),
  };
}

export type MerchantApi = ReturnType<typeof createMerchantApi>;
