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
/** Public images expose WebP sizes only; originals are private (FR-FILE-003). */
export interface FileUrls {
  original?: string;
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
  cancellation?: { reasonCode: string; initiatorType: string } | null;
  /** FR-RORD-007: the assigned delivery partner, if any. */
  partner: {
    firstName: string;
    vehicleType: string | null;
    deliveryStatus: string;
    assignedAt: string | null;
    arrivedAt: string | null;
    pickedUpAt: string | null;
  } | null;
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

export type MenuTag =
  'VEGAN' | 'JAIN' | 'GLUTEN_FREE' | 'DAIRY_FREE' | 'SPICY' | 'KETO' | 'HIGH_PROTEIN';
export type Allergen =
  | 'GLUTEN'
  | 'CRUSTACEANS'
  | 'EGGS'
  | 'FISH'
  | 'PEANUTS'
  | 'SOY'
  | 'MILK'
  | 'TREE_NUTS'
  | 'CELERY'
  | 'MUSTARD'
  | 'SESAME'
  | 'SULPHITES'
  | 'LUPIN'
  | 'MOLLUSCS';

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  basePriceAmount: number;
  discountedPriceAmount: number | null;
  dietaryMarker: DietaryMarker;
  spiceLevel: number | null;
  servingSize: string | null;
  prepMinutes: number | null;
  calories: number | null;
  isHidden: boolean;
  hiddenReason?: string | null;
  isBestseller: boolean;
  isRecommended: boolean;
  isTodaysSpecial: boolean;
  isFeatured: boolean;
  packagingFeeAmount: number | null;
  tags: MenuTag[];
  allergens: Allergen[];
  ingredients: string[];
  images: { id: string; fileId: string; position?: number; urls: FileUrls | null }[];
  variants: {
    id: string;
    name: string;
    priceAmount: number;
    isDefault: boolean;
    position?: number;
  }[];
  /** Attached option groups; `variantId` null means every variant. */
  customizationGroups: { groupId: string; variantId: string | null; position?: number }[];
  version: number;
  available?: boolean;
  unavailableUntil?: string | null;
}

/** Editable dish fields (API-RMENU-007/009); amounts in paise. */
export interface ItemInput {
  categoryId: string;
  name: string;
  description?: string | null;
  basePriceAmount: number;
  discountedPriceAmount?: number | null;
  dietaryMarker: DietaryMarker;
  spiceLevel?: number | null;
  servingSize?: string | null;
  prepMinutes?: number | null;
  calories?: number | null;
  isBestseller?: boolean;
  isRecommended?: boolean;
  isTodaysSpecial?: boolean;
  isFeatured?: boolean;
  isHidden?: boolean;
  packagingFeeAmount?: number | null;
  tags?: MenuTag[];
  allergens?: Allergen[];
  ingredients?: string[];
}

export interface OptionInput {
  name: string;
  priceDeltaAmount: number;
  dietaryMarker: DietaryMarker;
  isDefault?: boolean;
}

export interface CustomizationGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  required?: boolean;
  attachedTo?: number;
  options: {
    id: string;
    name: string;
    priceDeltaAmount: number;
    dietaryMarker: DietaryMarker;
    isDefault?: boolean;
    position?: number;
    available?: boolean;
  }[];
}

export interface ManagedMenu {
  categories: {
    id: string;
    name: string;
    description: string | null;
    position?: number;
    isActive: boolean;
    items: MenuItem[];
  }[];
  customizationGroups: CustomizationGroup[];
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

export interface SalesPoint {
  bucket: string;
  orders: number;
  delivered: number;
  revenue: number;
  averageOrderValue: number | null;
  cancellationRate: number;
  rejectionRate: number;
  newCustomers: number;
  repeatCustomers: number;
}
export interface SalesReport {
  granularity: 'day' | 'week' | 'month';
  series: SalesPoint[];
  totals: { orders: number; delivered: number; revenue: number };
  previousTotals: { orders: number; delivered: number; revenue: number };
}
export interface TopItem {
  foodItemId: string;
  name: string;
  quantity: number;
  revenue: number;
}
export interface CategorySales {
  categoryId: string;
  name: string;
  quantity: number;
  revenue: number;
}
export interface OperationsReport {
  orders: number;
  acceptanceRate: number;
  rejectionRate: number;
  timeoutRate: number;
  restaurantCancellationRate: number;
  avgAcceptSeconds: number;
  avgPrepSeconds: number;
  lateReadyRate: number;
}
export interface AnalyticsRange {
  from: string;
  to: string;
  branchIds?: string[];
}

export interface BranchReview {
  id: string;
  orderId: string;
  rating: number;
  text: string | null;
  tags: string[];
  photos: { id: string; urls: FileUrls | null }[];
  status: 'PUBLISHED' | 'HIDDEN';
  author: string;
  orderNumber: string;
  response: { text: string; at: string; editable: boolean } | null;
  createdAt: string;
}
export type ReviewReportReason = 'SPAM' | 'ABUSIVE' | 'IRRELEVANT' | 'FAKE' | 'OTHER';

export interface RestaurantProfile {
  id: string;
  brandName: string;
  slug: string;
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
  cover: { fileId: string; urls: FileUrls | null } | null;
  bank: { holderName: string; accountMasked: string; ifsc: string; status: string } | null;
  pendingChanges: ChangeRequestType[];
  rating: { average: number; count: number } | null;
}
export type ChangeRequestType = 'LEGAL_NAME' | 'PAN' | 'GSTIN' | 'FSSAI' | 'BANK_ACCOUNT';
export interface ChangeRequest {
  id: string;
  type: ChangeRequestType;
  status: string;
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}
export type ChangeRequestBody =
  | { type: 'LEGAL_NAME'; values: { legalName: string } }
  | { type: 'PAN'; values: { pan: string } }
  | { type: 'GSTIN'; values: { gstin: string } }
  | { type: 'FSSAI'; values: { fssaiNumber: string; fssaiExpiresOn: string } }
  | { type: 'BANK_ACCOUNT'; values: { holderName: string; accountNumber: string; ifsc: string } };

export interface RestaurantPayout {
  id: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  status: 'PENDING' | 'PAID' | 'FAILED';
  utr: string | null;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
  bank: { accountMasked: string; ifsc: string } | null;
  settlement: {
    gross: number;
    commission: number;
    discounts: number;
    taxes: number;
    adjustments: number;
    net: number;
  } | null;
}

/** Typed wrappers for the restaurant app (SRS §14 merchant APIs). */
export function createMerchantApi(client: ApiClient) {
  const R = (rid: string) => `/merchant/restaurants/${rid}`;
  const B = (bid: string) => `/merchant/branches/${bid}`;
  const O = (oid: string) => `/merchant/orders/${oid}`;
  const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });
  const rangeParams = ({ branchIds, ...rest }: AnalyticsRange & { granularity?: string }) => ({
    ...rest,
    ...(branchIds?.length ? { branchIds: branchIds.join(',') } : {}),
  });
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
      /** API-RORD-009: hand over against the partner's 4-digit pickup code. */
      handover: (oid: string, pickupCode: string) =>
        client.post<{ orderId: string; status: string; partner: string | null }>(
          `${O(oid)}/handover`,
          { pickupCode },
          idem(),
        ),
    },
    menu: {
      get: (rid: string, branchId?: string) =>
        client.get<ManagedMenu>(`${R(rid)}/menu`, { branchId }),
      createCategory: (rid: string, name: string) => client.post(`${R(rid)}/categories`, { name }),
      updateCategory: (rid: string, cid: string, body: { name?: string; isActive?: boolean }) =>
        client.patch(`${R(rid)}/categories/${cid}`, body),
      reorderCategories: (rid: string, categoryIds: string[]) =>
        client.put(`${R(rid)}/categories/order`, { categoryIds }),
      /** Items move to `moveItemsTo` (required when the category still has dishes). */
      deleteCategory: (rid: string, cid: string, moveItemsTo?: string) =>
        client.delete(`${R(rid)}/categories/${cid}`, moveItemsTo ? { moveItemsTo } : undefined),
      reorderItems: (rid: string, cid: string, itemIds: string[]) =>
        client.put(`${R(rid)}/categories/${cid}/items/order`, { itemIds }),
      item: (rid: string, iid: string) => client.get<MenuItem>(`${R(rid)}/items/${iid}`),
      createItem: (rid: string, body: Record<string, unknown>) =>
        client.post<MenuItem>(`${R(rid)}/items`, body),
      /** With `version`, sends If-Match; a stale version fails with CONFLICT_STALE_VERSION. */
      updateItem: (rid: string, iid: string, body: Record<string, unknown>, version?: number) =>
        client.patch<MenuItem>(
          `${R(rid)}/items/${iid}`,
          body,
          version === undefined ? undefined : { 'If-Match': `"${version}"` },
        ),
      deleteItem: (rid: string, iid: string) => client.delete(`${R(rid)}/items/${iid}`),
      addImage: (rid: string, iid: string, fileId: string) =>
        client.post<MenuItem>(`${R(rid)}/items/${iid}/images`, { fileId }),
      reorderImages: (rid: string, iid: string, imageIds: string[]) =>
        client.put<MenuItem>(`${R(rid)}/items/${iid}/images/order`, { imageIds }),
      removeImage: (rid: string, iid: string, imageId: string) =>
        client.delete<MenuItem>(`${R(rid)}/items/${iid}/images/${imageId}`),
      addVariant: (
        rid: string,
        iid: string,
        body: { name: string; priceAmount: number; isDefault?: boolean },
      ) => client.post<MenuItem>(`${R(rid)}/items/${iid}/variants`, body),
      updateVariant: (
        rid: string,
        iid: string,
        vid: string,
        body: { name?: string; priceAmount?: number; isDefault?: boolean },
      ) => client.patch<MenuItem>(`${R(rid)}/items/${iid}/variants/${vid}`, body),
      deleteVariant: (rid: string, iid: string, vid: string) =>
        client.delete<MenuItem>(`${R(rid)}/items/${iid}/variants/${vid}`),
      /** Replaces the dish's option groups (per variant when `variantId` is set). */
      attachGroups: (
        rid: string,
        iid: string,
        groups: { groupId: string; variantId?: string | null }[],
      ) => client.put<MenuItem>(`${R(rid)}/items/${iid}/customization-groups`, { groups }),
      groups: (rid: string) => client.get<CustomizationGroup[]>(`${R(rid)}/customization-groups`),
      createGroup: (
        rid: string,
        body: { name: string; minSelect: number; maxSelect: number; options?: OptionInput[] },
      ) => client.post<CustomizationGroup>(`${R(rid)}/customization-groups`, body),
      updateGroup: (
        rid: string,
        gid: string,
        body: { name?: string; minSelect?: number; maxSelect?: number },
      ) => client.patch<CustomizationGroup>(`${R(rid)}/customization-groups/${gid}`, body),
      deleteGroup: (rid: string, gid: string) =>
        client.delete(`${R(rid)}/customization-groups/${gid}`),
      addOption: (rid: string, gid: string, body: OptionInput) =>
        client.post<CustomizationGroup>(`${R(rid)}/customization-groups/${gid}/options`, body),
      updateOption: (rid: string, gid: string, oid: string, body: Partial<OptionInput>) =>
        client.patch<CustomizationGroup>(
          `${R(rid)}/customization-groups/${gid}/options/${oid}`,
          body,
        ),
      deleteOption: (rid: string, gid: string, oid: string) =>
        client.delete<CustomizationGroup>(`${R(rid)}/customization-groups/${gid}/options/${oid}`),
      setAvailability: (bid: string, iid: string, available: boolean, until?: 'END_OF_DAY') =>
        client.put(`${B(bid)}/items/${iid}/availability`, {
          available,
          ...(until ? { until } : {}),
        }),
      setOptionAvailability: (bid: string, oid: string, available: boolean, until?: 'END_OF_DAY') =>
        client.put(`${B(bid)}/options/${oid}/availability`, {
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
    /** API-MER-008…013: profile, legal change requests (need a recent re-auth). */
    restaurant: {
      get: (rid: string) => client.get<RestaurantProfile>(R(rid)),
      update: (
        rid: string,
        body: {
          description?: string | null;
          contactEmail?: string;
          contactPhone?: string;
          cuisineIds?: string[];
          pureVeg?: boolean;
        },
      ) => client.patch<RestaurantProfile>(R(rid), body),
      setImage: (rid: string, kind: 'logo' | 'cover', fileId: string) =>
        client.put<RestaurantProfile>(`${R(rid)}/${kind}`, { fileId }),
      changeRequests: (rid: string) => client.get<ChangeRequest[]>(`${R(rid)}/change-requests`),
      requestChange: (rid: string, body: ChangeRequestBody) =>
        client.post<ChangeRequest>(`${R(rid)}/change-requests`, body),
      /** FR-RFIN-002: payout history (rest.finance:read). */
      payouts: (rid: string, params: { cursor?: string; limit?: number } = {}) =>
        client.getPage<RestaurantPayout[]>(`${R(rid)}/payouts`, params),
    },
    /** API-RREV-001…004 */
    reviews: {
      list: (
        bid: string,
        params: { rating?: number; responded?: boolean; cursor?: string; limit?: number } = {},
      ) => client.getPage<BranchReview[]>(`${B(bid)}/reviews`, params),
      respond: (reviewId: string, text: string) =>
        client.post<{ reviewId: string; text: string }>(`/merchant/reviews/${reviewId}/response`, {
          text,
        }),
      editResponse: (reviewId: string, text: string) =>
        client.patch<{ reviewId: string; text: string }>(`/merchant/reviews/${reviewId}/response`, {
          text,
        }),
      report: (reviewId: string, body: { reason: ReviewReportReason; note?: string }) =>
        client.post(`/merchant/reviews/${reviewId}/reports`, body),
    },
    /** API-RANL-002…004, 007 */
    analytics: {
      sales: (rid: string, r: AnalyticsRange & { granularity?: 'day' | 'week' | 'month' }) =>
        client.get<SalesReport>(`${R(rid)}/analytics/sales`, rangeParams(r)),
      items: (rid: string, r: AnalyticsRange) =>
        client.get<TopItem[]>(`${R(rid)}/analytics/items`, rangeParams(r)),
      categories: (rid: string, r: AnalyticsRange) =>
        client.get<CategorySales[]>(`${R(rid)}/analytics/categories`, rangeParams(r)),
      operations: (rid: string, r: AnalyticsRange) =>
        client.get<OperationsReport>(`${R(rid)}/analytics/operations`, rangeParams(r)),
    },
    dashboard: (rid: string, branchIds?: string[]) =>
      client.get<Dashboard>(
        `${R(rid)}/dashboard`,
        branchIds ? { branchIds: branchIds.join(',') } : {},
      ),
  };
}

export type MerchantApi = ReturnType<typeof createMerchantApi>;
