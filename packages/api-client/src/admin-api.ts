import type { ApiSuccess } from '@fos/types';
import { toClientError, type ApiClient } from './client';
import type { Application, OnboardingStatus } from './merchant-api';
import type { PartnerApplication } from './partner-api';

/* Admin console endpoints (API-ADM-*). Amounts are paise; dates are ISO strings. */

export interface AdminPagination {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}
export interface AdminPage<T> {
  data: T[];
  pagination: AdminPagination;
}
export interface AdminPageQuery {
  page?: number;
  pageSize?: number;
}
type Query = Record<string, string | number | boolean | null | undefined>;

export interface AdminPerson {
  id: string;
  fullName: string;
}
export type AdminAccountStatus = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
export type AdminUserStatus =
  'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'ANONYMIZED';
export type AdminStaffRole = 'SUPPORT_AGENT' | 'ADMIN' | 'SUPER_ADMIN';

/* ------------------------------ dashboard ------------------------------ */

export interface AdminDashboard {
  asOf: string;
  today: string;
  users: { total: number; newToday: number };
  customers: { total: number };
  restaurants: { total: number; activeNow: number; pendingApprovals: number };
  partners: { total: number; onlineNow: number; onDelivery: number; pendingApprovals: number };
  orders: {
    active: Record<string, number>;
    activeTotal: number;
    completedToday: number;
    cancelledToday: number;
    rejectedToday: number;
    failedToday: number;
  };
  gmv: { today: number; orders: number };
  platformRevenue: { today: number; commission: number; fees: number };
  refunds: {
    createdToday: number;
    createdAmountToday: number;
    succeededAmountToday: number;
    pending: number;
  };
  payouts: { pendingLines: number; pendingAmount: number; draftBatches: number };
  alerts: {
    open: number;
    bySeverity: { CRITICAL: number; WARNING: number; INFO: number };
    byType: Record<string, number>;
    unassignedDeliveries: number;
  };
}

export type AdminAlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export interface AdminAlert {
  id: string;
  type: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  status: AdminAlertStatus;
  message: string;
  ref: { type: string; id: string | null } | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: AdminPerson | null;
  resolvedAt: string | null;
}

/* ------------------------------ users ------------------------------ */

export interface AdminUserRow {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  status: AdminUserStatus;
  roles: string[];
  createdAt: string;
}
export interface AdminUser extends AdminUserRow {
  phoneVerified: boolean;
  emailVerified: boolean;
  suspension: { reason: string | null; until: string | null } | null;
  flags: { codBlocked: boolean; codRefusalCount: number };
  wallet: { availableAmount: number; heldAmount: number };
  orders: { total: number; delivered: number };
  activeSessions: number;
  partner: { id: string; onboardingStatus: string; status: string } | null;
  restaurants: {
    id: string;
    brandName: string;
    status: string;
    role: string;
    memberStatus: string;
  }[];
  deletionScheduledAt: string | null;
}
export interface AdminSession {
  id: string;
  app: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
}

/* ------------------------------ restaurants ------------------------------ */

export interface AdminRestaurantApplicationRow {
  id: string;
  brandName: string;
  legalName: string;
  status: OnboardingStatus;
  submissionCount: number;
  city: string | null;
  area: string | null;
  owner: AdminPerson | null;
  createdAt: string;
  waitingSince: string;
}
export interface AdminRestaurantApplication extends Application {
  owner: AdminPerson | null;
  reviews: {
    submissionNo: number;
    decision: string;
    comments: Record<string, string> | null;
    createdAt: string;
    reviewer: AdminPerson | null;
  }[];
  flags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminBranchRow {
  id: string;
  name: string;
  status: string;
  zoneId: string | null;
}
export interface AdminRestaurantRow {
  id: string;
  brandName: string;
  status: AdminAccountStatus;
  codEnabled: boolean;
  rating: { average: number; count: number } | null;
  branches: AdminBranchRow[];
  approvedAt: string | null;
}
export interface AdminRestaurant {
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
  bank: { holderName: string; accountMasked: string; ifsc: string; status: string } | null;
  pendingChanges: string[];
  rating: { average: number; count: number } | null;
  status: AdminAccountStatus;
  onboardingStatus: OnboardingStatus;
  codEnabled: boolean;
  approvedAt: string | null;
  commission: {
    rateBps: number;
    source: string;
    scheduled: { rateBps: number; effectiveFrom: string }[];
  } | null;
  branches: {
    id: string;
    name: string;
    area: string;
    city: string;
    status: string;
    isOpenManual: boolean;
    pausedUntil: string | null;
    zone: { id: string; name: string } | null;
  }[];
  members: {
    role: string;
    status: string;
    user: { id: string; fullName: string; phone: string };
  }[];
  orders: { total: number; delivered: number };
  cancelledOrders?: number;
  notCancelledOrders?: number;
}
export type AdminChangeType = 'LEGAL_NAME' | 'PAN' | 'GSTIN' | 'FSSAI' | 'BANK_ACCOUNT';
export interface AdminChangeRequest {
  id: string;
  type: AdminChangeType;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  restaurant: { id: string; brandName: string };
  requested: Record<string, string>;
  reason: string | null;
  requestedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
}
export interface AdminDocumentUrl {
  documentId: string;
  type: string;
  url: string;
  expiresAt: string | null;
}

/* ------------------------------ partners ------------------------------ */

export interface AdminPartnerApplicationRow {
  id: string;
  userId: string;
  legalName: string | null;
  phone: string | null;
  status: OnboardingStatus;
  submissionCount: number;
  zone: { id: string; name: string } | null;
  vehicleType: string | null;
  createdAt: string;
  waitingSince: string;
}
export interface AdminPartnerApplication extends PartnerApplication {
  user: { id: string; fullName: string; phone: string | null };
  submissionCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface AdminPartnerRow {
  id: string;
  userId: string;
  legalName: string | null;
  phone: string | null;
  status: AdminAccountStatus;
  zone: { id: string; name: string } | null;
  availability: string;
  rating: { average: number; count: number } | null;
  deliveriesToday: number;
}
export interface AdminPartner extends AdminPartnerApplication {
  accountStatus: AdminAccountStatus;
  presence: {
    state: string;
    zoneId?: string | null;
    location?: { lat: number; lng: number } | null;
    at?: string;
    offlineAfterCurrent?: boolean;
  };
  activeDelivery: { id: string; orderId: string; status: string } | null;
  cashInHand: number;
  earningsBalance: number;
  performance: Record<string, unknown> | null;
  recentDeliveries: {
    id: string;
    status: string;
    createdAt: string;
    deliveredAt: string | null;
    order: { id: string; number: string };
  }[];
}
export interface AdminLocationTrail {
  partnerId: string;
  deliveryId: string;
  status: string;
  orderId: string;
  points: {
    lat: number;
    lng: number;
    accuracyM: number;
    heading: number | null;
    speedKmh: number | null;
    recordedAt: string;
  }[];
}

/* ------------------------------ orders ------------------------------ */

export type AdminOrderStatus =
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
export interface AdminOrderRow {
  id: string;
  number: string;
  status: AdminOrderStatus;
  refundStatus: string | null;
  paymentMethod: string;
  totalAmount: number;
  createdAt: string;
  placedAt: string | null;
  customer: { id: string; name: string; phone: string | null };
  restaurant: { id: string; name: string };
  branch: { id: string; name: string; zoneId: string | null };
  delivery: {
    id: string;
    status: string;
    escalated: boolean;
    partner: { id: string; name: string | null } | null;
  } | null;
}
export interface AdminStatusChange {
  from: string | null;
  to: string;
  actorType: string;
  actorId: string | null;
  reason?: string | null;
  metadata?: unknown;
  flagged?: boolean;
  at: string;
}
export interface AdminRefund {
  id: string;
  orderId: string;
  order?: { id: string; number: string };
  paymentId: string | null;
  amount: number;
  destination: 'SOURCE' | 'WALLET';
  status: string;
  reasonCode: string;
  note: string | null;
  initiatorType: string;
  initiator?: AdminPerson | null;
  costBearer: string;
  attempts: number;
  providerRefundId?: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface AdminPaymentAttempt {
  id: string;
  providerPaymentId: string | null;
  status: string;
  amount: number;
  methodDetail: string | null;
  errorCode: string | null;
  createdAt: string;
}
export interface AdminOrder {
  id: string;
  number: string;
  status: AdminOrderStatus;
  refundStatus: string | null;
  failureReason: string | null;
  paymentMethod: string;
  amounts: {
    itemsSubtotal: number;
    discounts: number;
    fees: number;
    taxes: number;
    tip: number;
    wallet: number;
    total: number;
    payable: number;
  };
  priceComponents: { type: string; code: string; label: string; amount: number }[];
  customer: { id: string; name: string; phone: string | null };
  contact: { name: string | null; phone: string | null };
  address: { line1: string; area: string; city: string; pincode: string } | null;
  restaurant: { id: string; name: string };
  branch: { id: string; name: string; zoneId: string | null };
  items: {
    id: string;
    name: string;
    variant: string | null;
    quantity: number;
    lineTotal: number;
    options: string[];
  }[];
  timestamps: Record<string, string | null>;
  payments: {
    id: string;
    method: string;
    provider: string;
    providerOrderId: string | null;
    status: string;
    amount: number;
    capturedAmount: number;
    refundedAmount: number;
    instrument: string | null;
    failureCode: string | null;
    attempts: AdminPaymentAttempt[];
  }[];
  webhookEvents: {
    id: string;
    provider: string;
    eventType: string;
    processingStatus: string;
    receivedAt: string;
  }[];
  refunds: AdminRefund[];
  cancellation: {
    reasonCode: string;
    fault?: string | null;
    note?: string | null;
    [key: string]: unknown;
  } | null;
  issues: unknown[];
  delivery: {
    id: string;
    status: string;
    escalated: boolean;
    searchRound: number;
    noPartnerDeadline: string | null;
    deadlineExtended: boolean;
    proofType: string | null;
    failureReason: string | null;
    partner: { id: string; name: string | null; phone: string | null } | null;
    assignments: {
      id: string;
      partner: { id: string; name: string | null };
      status: string;
      round: number;
      rank: number | null;
      manual: boolean;
      distanceToPickupM: number | null;
      offeredAt: string;
      expiresAt: string | null;
      respondedAt: string | null;
      rejectReason: string | null;
    }[];
    history: {
      id: string;
      fromStatus: string | null;
      toStatus: string;
      actorType: string;
      flagged: boolean;
      createdAt: string;
    }[];
  } | null;
  statusHistory: AdminStatusChange[];
}
export interface AdminAuditEntry {
  id: string;
  action: string;
  actor: AdminPerson | null;
  actorRoles: string[];
  reason: string | null;
  before: unknown;
  after: unknown;
  sensitivity: 'NORMAL' | 'HIGH';
}
export interface AdminOrderAudit {
  orderId: string;
  number: string;
  audit: (AdminAuditEntry & { targetType: string; targetId: string; at: string })[];
  statusHistory: AdminStatusChange[];
  deliveryHistory: AdminStatusChange[];
}
export type AdminFault = 'CUSTOMER' | 'RESTAURANT' | 'PARTNER' | 'PLATFORM';
export interface AdminRefundInput {
  amount: number;
  items?: { orderItemId: string; quantity: number }[];
  destination: 'SOURCE' | 'WALLET';
  reasonCode: string;
  note: string;
  costBearer: 'PLATFORM' | 'RESTAURANT' | 'PARTNER';
  requestApproval?: boolean;
}

/* ------------------------------ dispatch ------------------------------ */

export interface AdminDeliveryRow {
  id: string;
  status: string;
  escalated: boolean;
  searchRound: number;
  offers: number;
  openOffer: { id: string; partnerId: string; expiresAt: string | null } | null;
  noPartnerDeadline: string | null;
  deadlineExtended: boolean;
  createdAt: string;
  assignedAt: string | null;
  order: {
    id: string;
    number: string;
    status: string;
    readyBy: string | null;
    paymentMethod: string;
  };
  restaurant: { name: string; branch: string };
  zoneId: string | null;
  partner: { id: string; name: string | null; phone: string | null } | null;
  manualAssignment: { acknowledgeBy: string | null; acknowledgedAt: string | null } | null;
}
export interface AdminCandidate {
  rank: number;
  partnerId: string;
  name: string | null;
  phone: string | null;
  distanceM: number;
  etaMinutes: number;
  acceptanceRate: number | null;
  rating: number | null;
  deliveriesToday: number;
  score: number;
}

/* ------------------------------ finance ------------------------------ */

export interface AdminPaymentRow {
  id: string;
  order: { id: string; number: string; status: string };
  method: string;
  provider: string;
  providerOrderId: string | null;
  status: string;
  amount: number;
  capturedAmount: number;
  refundedAmount: number;
  instrument: string | null;
  failure: { code: string; reason: string | null } | null;
  capturedAt: string | null;
  createdAt: string;
}
export interface AdminWebhookEvent {
  id: string;
  provider?: string;
  eventId: string;
  eventType: string;
  signatureValid: boolean;
  processingStatus: string;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
}
export interface AdminPayment extends AdminPaymentRow {
  attempts: (AdminPaymentAttempt & { updatedAt: string })[];
  refunds: {
    id: string;
    amount: number;
    status: string;
    destination: string;
    providerRefundId: string | null;
    createdAt: string;
  }[];
  webhookEvents: AdminWebhookEvent[];
  sync?: Record<string, unknown>;
}
export type AdminPayeeType = 'RESTAURANT' | 'PARTNER';
export type AdminBatchStatus = 'DRAFT' | 'APPROVED' | 'PROCESSING' | 'PAID' | 'PARTIALLY_FAILED';
export interface AdminBatchTotals {
  lines: number;
  amount: number;
  pending: { lines: number; amount: number };
  paid: { lines: number; amount: number };
  failed: { lines: number; amount: number };
}
export interface AdminPayoutBatchRow {
  id: string;
  type: AdminPayeeType;
  periodStart: string;
  periodEnd: string;
  status: AdminBatchStatus;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  totals: AdminBatchTotals;
}
export interface AdminPayoutLine {
  id: string;
  payeeType: AdminPayeeType;
  payee: { id: string; name: string | null };
  bank: { holderName: string; accountMasked: string; ifsc: string } | null;
  amount: number;
  cashDeduction: number;
  status: 'PENDING' | 'PAID' | 'FAILED';
  utr: string | null;
  failureReason: string | null;
  paidAt: string | null;
}
export interface AdminPayoutBatch extends AdminPayoutBatchRow {
  lines: AdminPayoutLine[];
  skipped?: unknown[];
}
export interface AdminPayoutExport {
  batchId: string;
  filename: string;
  contentType: string;
  lines: number;
  csv: string;
}

/* ------------------------------ coupons ------------------------------ */

export interface AdminCouponFields {
  description: string;
  discountType: 'FLAT' | 'PERCENT' | 'FREE_DELIVERY';
  value: number;
  maxDiscountAmount: number | null;
  minSubtotalAmount: number;
  startsAt: string;
  endsAt: string;
  usageLimitTotal: number | null;
  usageLimitPerUser: number;
  userSegment: 'ALL' | 'NEW_USERS' | 'TARGETED';
  userIds: string[];
  paymentMethodRestriction: 'ONLINE' | 'COD' | null;
  funding: 'PLATFORM' | 'RESTAURANT' | 'SHARED';
  restaurantShareBps: number;
  restaurantIds: string[];
  zoneIds: string[];
  stackableWithPromotion: boolean;
  visibility: 'PUBLIC' | 'HIDDEN';
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
}
export interface AdminCoupon extends AdminCouponFields {
  id: string;
  code: string;
  usedCount: number;
  reservedCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  stats?: { reserved: number; redeemed: number; released: number; discountGiven: number };
}
export type AdminCouponInput = Partial<Omit<AdminCouponFields, 'status'>> & {
  status?: 'DRAFT' | 'ACTIVE';
  reason: string;
};
export interface AdminRedemption {
  id: string;
  status: string;
  discountAmount: number;
  createdAt: string;
  customer: { id: string; fullName: string; phone: string | null };
  order: { id: string; number: string; status: string } | null;
}

/* ------------------------------ zones ------------------------------ */

export interface AdminPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}
export interface AdminZone {
  id: string;
  name: string;
  city: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  suspensionReason: string | null;
  maxDeliveryRadiusM: number;
  rainMode: boolean;
  surge: { active: boolean; amount: number; reason: string | null; until: string | null };
  polygon: AdminPolygon;
  areaKm2: number;
  branchCount: number;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------ settings and pricing ------------------------------ */

export interface AdminSetting {
  key: string;
  description: string;
  critical: boolean;
  default: unknown;
  value: unknown;
  storedValueInvalid: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}
export interface AdminSettingChange {
  id: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  changedBy: AdminPerson | null;
  createdAt: string;
}
export type AdminVersionState = 'IN_EFFECT' | 'SCHEDULED' | 'SUPERSEDED';
export interface AdminFeeSchedule {
  id: string;
  zoneId: string | null;
  platformFeeAmount: number;
  smallOrderThresholdAmount: number;
  smallOrderFeeAmount: number;
  perKmBeyondSlabsAmount: number;
  packagingCapPerItemAmount: number;
  packagingCapPerOrderAmount: number;
  surgeCapAmount: number;
  slabs: { fromM: number; toM: number; feeAmount: number }[];
  effectiveFrom: string;
  state: AdminVersionState;
}
export interface AdminTaxRule {
  id: string;
  component: string;
  taxCode: string;
  rateBps: number;
  collectedBy: 'PLATFORM' | 'RESTAURANT';
  effectiveFrom: string;
  state: AdminVersionState;
}
export interface AdminCommissionPlan {
  id: string;
  name: string;
  rateBps: number;
  effectiveFrom: string;
  state: AdminVersionState;
}
export interface AdminPayPlan {
  id: string;
  zoneId: string | null;
  baseAmount: number;
  perKmAmount: number;
  freeKmM: number;
  waitAfterMinutes: number;
  perWaitMinuteAmount: number;
  waitCapAmount: number;
  rainBonusAmount: number;
  cancellationMinAmount: number;
  effectiveFrom: string;
  state: AdminVersionState;
}

/* ------------------------------ support, moderation, IAM, audit, jobs ------------------------------ */

export type AdminTicketStatus =
  'OPEN' | 'PENDING_CUSTOMER' | 'PENDING_INTERNAL' | 'RESOLVED' | 'CLOSED';
export type AdminTicketPriority = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
export type AdminTicketCategory =
  'ORDER_ISSUE' | 'PAYMENT' | 'REFUND' | 'ACCOUNT' | 'DELIVERY' | 'FEEDBACK' | 'OTHER';
export interface AdminTicketRow {
  id: string;
  number: string;
  category: AdminTicketCategory;
  subject: string;
  status: AdminTicketStatus;
  priority: AdminTicketPriority;
  requester: AdminPerson & { type: string };
  assignee: AdminPerson | null;
  order: { id: string; number: string; status: string } | null;
  slaDueAt: string | null;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AdminTicket {
  id: string;
  number: string;
  category: AdminTicketCategory;
  subject: string;
  status: AdminTicketStatus;
  priority: AdminTicketPriority;
  slaDueAt: string | null;
  resolvedAt: string | null;
  csat: number | null;
  createdAt: string;
  updatedAt: string;
  assignee: AdminPerson | null;
  requester: {
    id: string;
    type: string;
    fullName: string;
    phone: string | null;
    memberSince: string;
    orders: number;
    openTickets: number;
  };
  order: {
    id: string;
    number: string;
    status: string;
    totalAmount: number;
    paymentMethod: string;
    placedAt: string | null;
    deliveredAt: string | null;
    restaurant: string;
    branch: { id: string; name: string };
  } | null;
  messages: {
    id: string;
    authorType: string;
    author: AdminPerson | null;
    body: string;
    internal: boolean;
    attachments: string[];
    at: string;
  }[];
}
export interface AdminReportedReview {
  id: string;
  targetType: string;
  rating: number;
  text: string | null;
  status: string;
  createdAt: string;
  author: AdminPerson | null;
  restaurant: { id: string; brandName: string } | null;
  branch: { id: string; name: string } | null;
  partnerId: string | null;
  reports: {
    count: number;
    reasons: Record<string, number>;
    latest: { reason: string; note: string | null; createdAt: string }[];
  };
}
export interface AdminRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  system: boolean;
  appScope: string | null;
  assignable: boolean;
  userCount: number;
  permissions: string[];
}
export interface AdminPermission {
  key: string;
  description: string | null;
  scope: string;
  roles: string[];
}
export interface AdminAuditLog extends AdminAuditEntry {
  target: { type: string; id: string };
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}
export interface AdminFailedJob {
  id: string;
  queue: string;
  name: string;
  data: Record<string, unknown>;
  failedReason: string | null;
  attemptsMade: number;
  createdAt: string | null;
  failedAt: string | null;
}

/** Drops empty filters so optional query params aren't sent as "" (which fails validation). */
function clean(params: object = {}): Query {
  return Object.fromEntries(
    Object.entries(params as Query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
}

export function createAdminApi(client: ApiClient) {
  const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });
  const r = (reason: string) => ({ reason });

  /** GET a page-numbered admin table (`?page&pageSize`): rows plus `meta.pagination`. */
  async function paged<T>(path: string, params?: object): Promise<AdminPage<T>> {
    try {
      const response = await client.http.get<ApiSuccess<T[]>>(`/api/v1${path}`, {
        params: clean(params),
      });
      const p = response.data.meta.pagination ?? {};
      return {
        data: response.data.data,
        pagination: {
          page: p.page ?? 1,
          pageSize: p.pageSize ?? response.data.data.length,
          total: p.total ?? response.data.data.length,
          hasMore: p.hasMore ?? false,
        },
      };
    } catch (error) {
      throw toClientError(error);
    }
  }
  const get = <T>(path: string, params?: object) => client.get<T>(path, clean(params));
  /** DELETE with a JSON body (role revocation carries its ★ reason). */
  async function del<T>(path: string, body: unknown): Promise<T> {
    try {
      const response = await client.http.delete<ApiSuccess<T>>(`/api/v1${path}`, { data: body });
      return response.data.data;
    } catch (error) {
      throw toClientError(error);
    }
  }

  const U = (id: string) => `/admin/users/${id}`;
  const RA = (id: string) => `/admin/restaurant-applications/${id}`;
  const PA = (id: string) => `/admin/partner-applications/${id}`;
  const R = (id: string) => `/admin/restaurants/${id}`;
  const P = (id: string) => `/admin/partners/${id}`;
  const O = (id: string) => `/admin/orders/${id}`;
  const D = (id: string) => `/admin/deliveries/${id}`;
  const B = (id: string) => `/admin/payout-batches/${id}`;

  return {
    dashboard: () => client.get<AdminDashboard>('/admin/dashboard'),
    alerts: {
      list: (q: AdminPageQuery & { status?: AdminAlertStatus; type?: string } = {}) =>
        paged<AdminAlert>('/admin/alerts', q),
      acknowledge: (id: string, body: { resolve?: boolean; note?: string } = {}) =>
        client.post<{ id: string; status: AdminAlertStatus }>(
          `/admin/alerts/${id}/acknowledge`,
          body,
        ),
    },
    users: {
      list: (q: AdminPageQuery & { q?: string; status?: AdminUserStatus; role?: string } = {}) =>
        paged<AdminUserRow>('/admin/users', q),
      get: (id: string) => client.get<AdminUser>(U(id)),
      sessions: (id: string) => client.get<AdminSession[]>(`${U(id)}/sessions`),
      suspend: (id: string, reason: string, until?: string) =>
        client.post<AdminUser>(`${U(id)}/suspend`, { reason, ...(until ? { until } : {}) }),
      unsuspend: (id: string, reason: string) =>
        client.post<AdminUser>(`${U(id)}/unsuspend`, r(reason)),
      logoutAll: (id: string, reason: string) =>
        client.post<{ sessionsRevoked: number }>(`${U(id)}/logout-all`, r(reason)),
      revealPii: (id: string, reason: string) =>
        client.post<{ id: string; phone: string | null; email: string | null }>(
          `${U(id)}/pii-reveal`,
          r(reason),
        ),
      adjustWallet: (id: string, body: { amount: number; reason: string; expiresAt?: string }) =>
        client.post<{ adjustmentId: string; amount: number; availableAmount: number }>(
          `${U(id)}/wallet-adjustments`,
          body,
          idem(),
        ),
      setCodBlock: (id: string, blocked: boolean, reason: string) =>
        client.post<{ userId: string; codBlocked: boolean }>(`${U(id)}/cod-block`, {
          blocked,
          reason,
        }),
      grantRole: (id: string, role: AdminStaffRole, reason: string) =>
        client.post<{ userId: string; roles: string[] }>(`${U(id)}/roles`, { role, reason }),
      revokeRole: (id: string, role: AdminStaffRole, reason: string) =>
        del<{ userId: string; roles: string[] }>(`${U(id)}/roles/${role}`, r(reason)),
    },
    restaurantApplications: {
      list: (q: AdminPageQuery & { status?: OnboardingStatus } = {}) =>
        paged<AdminRestaurantApplicationRow>('/admin/restaurant-applications', q),
      get: (id: string) => client.get<AdminRestaurantApplication>(RA(id)),
      startReview: (id: string) =>
        client.post<AdminRestaurantApplication>(`${RA(id)}/start-review`, {}),
      approve: (id: string, reason: string) =>
        client.post<AdminRestaurantApplication>(`${RA(id)}/approve`, r(reason)),
      reject: (id: string, reason: string) =>
        client.post<AdminRestaurantApplication>(`${RA(id)}/reject`, r(reason)),
      requestChanges: (id: string, comments: Record<string, string>, reason?: string) =>
        client.post<AdminRestaurantApplication>(`${RA(id)}/request-changes`, {
          comments,
          ...(reason ? { reason } : {}),
        }),
    },
    restaurants: {
      list: (q: AdminPageQuery & { q?: string; status?: AdminAccountStatus; zone?: string } = {}) =>
        paged<AdminRestaurantRow>('/admin/restaurants', q),
      get: (id: string) => client.get<AdminRestaurant>(R(id)),
      suspend: (id: string, reason: string, cancelActive = false) =>
        client.post<AdminRestaurant>(`${R(id)}/suspend`, { reason, cancelActive }),
      unsuspend: (id: string, reason: string) =>
        client.post<AdminRestaurant>(`${R(id)}/unsuspend`, r(reason)),
      setCommission: (
        id: string,
        body: { rateBps: number; effectiveFrom?: string; reason: string },
      ) =>
        client.put<{ restaurantId: string; rateBps: number; effectiveFrom: string }>(
          `${R(id)}/commission`,
          body,
        ),
      setCod: (id: string, enabled: boolean, reason: string) =>
        client.put<{ restaurantId: string; codEnabled: boolean }>(`${R(id)}/cod`, {
          enabled,
          reason,
        }),
    },
    branches: {
      setStatus: (id: string, action: 'suspend' | 'unsuspend' | 'approve', reason: string) =>
        client.post<{ id: string; restaurantId: string; status: string }>(
          `/admin/branches/${id}/${action}`,
          r(reason),
        ),
    },
    changeRequests: {
      list: (
        q: AdminPageQuery & { type?: AdminChangeType; status?: AdminChangeRequest['status'] } = {},
      ) => paged<AdminChangeRequest>('/admin/change-requests', q),
      decide: (id: string, decision: 'approve' | 'reject', reason: string) =>
        client.post<{ id: string; status: string }>(
          `/admin/change-requests/${id}/${decision}`,
          r(reason),
        ),
    },
    documents: {
      url: (id: string) => client.get<AdminDocumentUrl>(`/admin/documents/${id}/url`),
    },
    partnerApplications: {
      list: (q: AdminPageQuery & { status?: OnboardingStatus; zone?: string } = {}) =>
        paged<AdminPartnerApplicationRow>('/admin/partner-applications', q),
      get: (id: string) => client.get<AdminPartnerApplication>(PA(id)),
      approve: (id: string, reason: string) =>
        client.post<AdminPartnerApplication>(`${PA(id)}/approve`, r(reason)),
      reject: (id: string, reason: string) =>
        client.post<AdminPartnerApplication>(`${PA(id)}/reject`, r(reason)),
      requestChanges: (id: string, reason: string, documentNotes?: Record<string, string>) =>
        client.post<AdminPartnerApplication>(`${PA(id)}/request-changes`, {
          reason,
          ...(documentNotes && Object.keys(documentNotes).length ? { documentNotes } : {}),
        }),
      verifyVehicle: (vehicleId: string, decision: 'VERIFIED' | 'REJECTED', reason: string) =>
        client.post(`/admin/vehicles/${vehicleId}/verify`, { decision, reason }),
    },
    partners: {
      list: (
        q: AdminPageQuery & {
          q?: string;
          status?: AdminAccountStatus;
          online?: boolean;
          zone?: string;
        } = {},
      ) => paged<AdminPartnerRow>('/admin/partners', q),
      get: (id: string) => client.get<AdminPartner>(P(id)),
      suspend: (id: string, reason: string) =>
        client.post<{ id: string; status: string }>(`${P(id)}/suspend`, r(reason)),
      unsuspend: (id: string, reason: string) =>
        client.post<{ id: string; status: string }>(`${P(id)}/unsuspend`, r(reason)),
      forceOffline: (id: string, reason: string) =>
        client.post<{ id: string; offline: boolean; offlineAfterCurrentDelivery: boolean }>(
          `${P(id)}/force-offline`,
          r(reason),
        ),
      cashDeposit: (
        id: string,
        body: {
          amount: number;
          method: 'HUB' | 'UPI' | 'BANK';
          reference?: string;
          reason: string;
        },
      ) =>
        client.post<{ depositId: string; amount: number; cashInHand: number }>(
          `${P(id)}/cash-deposits`,
          body,
          idem(),
        ),
      adjustEarnings: (id: string, body: { amount: number; note?: string; reason: string }) =>
        client.post<{ adjustmentId: string; amount: number; earningsBalance: number }>(
          `${P(id)}/earning-adjustments`,
          body,
          idem(),
        ),
      locationTrail: (id: string, deliveryId: string) =>
        client.get<AdminLocationTrail>(`${P(id)}/location-trail`, { deliveryId }),
    },
    orders: {
      list: (
        q: AdminPageQuery & {
          q?: string;
          status?: AdminOrderStatus;
          zone?: string;
          restaurantId?: string;
          partnerId?: string;
          from?: string;
          to?: string;
        } = {},
      ) => paged<AdminOrderRow>('/admin/orders', q),
      get: (id: string) => client.get<AdminOrder>(O(id)),
      audit: (id: string) => client.get<AdminOrderAudit>(`${O(id)}/audit`),
      cancel: (id: string, body: { reasonCode: string; fault: AdminFault; reason: string }) =>
        client.post<unknown>(`${O(id)}/cancel`, body),
      markDelivered: (id: string, body: { reason: string; cashCollected?: boolean }) =>
        client.post<unknown>(`${O(id)}/mark-delivered`, body),
      markFailed: (
        id: string,
        body: { cause: 'DELIVERY_FAILED' | 'CUSTOMER_UNREACHABLE'; reason: string },
      ) => client.post<unknown>(`${O(id)}/mark-failed`, body),
      extendAcceptance: (id: string, body: { minutes: number; reason: string }) =>
        client.post<{ orderId: string; acceptBy: string }>(`${O(id)}/extend-acceptance`, body),
      refund: (id: string, body: AdminRefundInput) =>
        client.post<{ refund: AdminRefund }>(`${O(id)}/refunds`, body, idem()),
    },
    deliveries: {
      list: (q: AdminPageQuery & { status?: string; escalated?: boolean; zone?: string } = {}) =>
        paged<AdminDeliveryRow>('/admin/deliveries', q),
      candidates: (id: string) => client.get<AdminCandidate[]>(`${D(id)}/candidates`),
      assign: (id: string, body: { partnerId: string; force?: boolean; reason: string }) =>
        client.post<unknown>(`${D(id)}/assign`, body),
      reassign: (id: string, body: { partnerId: string; force?: boolean; reason: string }) =>
        client.post<unknown>(`${D(id)}/reassign`, body),
      redispatch: (id: string, reason?: string) =>
        client.post<unknown>(`${D(id)}/redispatch`, reason ? { reason } : {}),
      extendDeadline: (id: string, body: { minutes: number; reason: string }) =>
        client.post<{ deliveryId: string; noPartnerDeadline: string }>(
          `${D(id)}/extend-deadline`,
          body,
        ),
    },
    payments: {
      list: (q: AdminPageQuery & { q?: string; status?: string; provider?: string } = {}) =>
        paged<AdminPaymentRow>('/admin/payments', q),
      get: (id: string) => client.get<AdminPayment>(`/admin/payments/${id}`),
      sync: (id: string, reason: string) =>
        client.post<AdminPayment>(`/admin/payments/${id}/sync`, r(reason)),
      webhooks: (q: AdminPageQuery & { provider?: string; status?: string } = {}) =>
        paged<AdminWebhookEvent>('/admin/webhook-events', q),
    },
    refunds: {
      list: (q: AdminPageQuery & { status?: string } = {}) =>
        paged<AdminRefund>('/admin/refunds', q),
      approve: (id: string, reason: string) =>
        client.post<{ refund: AdminRefund }>(`/admin/refunds/${id}/approve`, r(reason)),
      retry: (id: string, reason: string) =>
        client.post<{ refund: AdminRefund }>(`/admin/refunds/${id}/retry`, r(reason)),
    },
    payouts: {
      list: (q: AdminPageQuery & { type?: AdminPayeeType; status?: AdminBatchStatus } = {}) =>
        paged<AdminPayoutBatchRow>('/admin/payout-batches', q),
      create: (body: { type: AdminPayeeType; periodStart?: string; reason: string }) =>
        client.post<AdminPayoutBatch>('/admin/payout-batches', body, idem()),
      get: (id: string) => client.get<AdminPayoutBatch>(B(id)),
      approve: (id: string, reason: string) =>
        client.post<AdminPayoutBatch>(`${B(id)}/approve`, r(reason)),
      export: (id: string) => client.get<AdminPayoutExport>(`${B(id)}/export`),
      markPaid: (id: string, lineId: string, body: { utr: string; reason: string }) =>
        client.post<AdminPayoutBatch>(`${B(id)}/lines/${lineId}/mark-paid`, body, idem()),
      markFailed: (id: string, lineId: string, reason: string) =>
        client.post<AdminPayoutBatch>(`${B(id)}/lines/${lineId}/mark-failed`, r(reason)),
    },
    coupons: {
      list: (q: AdminPageQuery & { q?: string; status?: AdminCoupon['status'] } = {}) =>
        paged<AdminCoupon>('/admin/coupons', q),
      get: (id: string) => client.get<AdminCoupon>(`/admin/coupons/${id}`),
      create: (body: AdminCouponInput & { code: string }) =>
        client.post<AdminCoupon>('/admin/coupons', body),
      update: (id: string, body: AdminCouponInput) =>
        client.patch<AdminCoupon>(`/admin/coupons/${id}`, body),
      deactivate: (id: string, reason: string) =>
        client.post<AdminCoupon>(`/admin/coupons/${id}/deactivate`, r(reason)),
      redemptions: (id: string, q: AdminPageQuery = {}) =>
        paged<AdminRedemption>(`/admin/coupons/${id}/redemptions`, q),
    },
    zones: {
      list: (q: AdminPageQuery & { status?: AdminZone['status']; city?: string } = {}) =>
        paged<AdminZone>('/admin/zones', q),
      get: (id: string) => client.get<AdminZone>(`/admin/zones/${id}`),
      create: (body: {
        name: string;
        city: string;
        polygon: AdminPolygon;
        maxDeliveryRadiusM?: number;
        reason: string;
      }) => client.post<AdminZone>('/admin/zones', body),
      update: (
        id: string,
        body: {
          name?: string;
          city?: string;
          polygon?: AdminPolygon;
          maxDeliveryRadiusM?: number;
          rainMode?: boolean;
          reason: string;
        },
      ) => client.patch<AdminZone>(`/admin/zones/${id}`, body),
      setStatus: (id: string, action: 'suspend' | 'activate', reason: string) =>
        client.post<AdminZone>(`/admin/zones/${id}/${action}`, r(reason)),
      setSurge: (
        id: string,
        body: { amount: number; until?: string; label?: string; reason: string },
      ) => client.put<AdminZone>(`/admin/zones/${id}/surge`, body),
    },
    settings: {
      list: () => client.get<AdminSetting[]>('/admin/settings'),
      update: (key: string, value: unknown, reason: string) =>
        client.patch<AdminSetting>(`/admin/settings/${encodeURIComponent(key)}`, {
          value,
          reason,
        }),
      history: (key: string, q: AdminPageQuery = {}) =>
        paged<AdminSettingChange>(`/admin/settings/${encodeURIComponent(key)}/history`, q),
    },
    pricing: {
      feeSchedules: (zoneId?: string) =>
        get<AdminFeeSchedule[]>('/admin/fee-schedules', { zoneId }),
      createFeeSchedule: (body: Record<string, unknown>) =>
        client.post<AdminFeeSchedule>('/admin/fee-schedules', body),
      taxRules: () => client.get<AdminTaxRule[]>('/admin/tax-rules'),
      createTaxRule: (body: Record<string, unknown>) =>
        client.post<AdminTaxRule>('/admin/tax-rules', body),
      commissionPlans: () => client.get<AdminCommissionPlan[]>('/admin/commission-plans'),
      createCommissionPlan: (body: Record<string, unknown>) =>
        client.post<AdminCommissionPlan>('/admin/commission-plans', body),
      payPlans: (zoneId?: string) => get<AdminPayPlan[]>('/admin/partner-pay-plans', { zoneId }),
      createPayPlan: (body: Record<string, unknown>) =>
        client.post<AdminPayPlan>('/admin/partner-pay-plans', body),
    },
    tickets: {
      list: (
        q: AdminPageQuery & {
          queue?: 'UNASSIGNED' | 'MINE' | 'OVERDUE';
          status?: AdminTicketStatus;
          priority?: AdminTicketPriority;
          category?: AdminTicketCategory;
          q?: string;
        } = {},
      ) => paged<AdminTicketRow>('/admin/tickets', q),
      get: (id: string) => client.get<AdminTicket>(`/admin/tickets/${id}`),
      message: (id: string, body: { body: string; internal: boolean }) =>
        client.post<unknown>(`/admin/tickets/${id}/messages`, body),
      assign: (id: string, assigneeId: string | null) =>
        client.post<unknown>(`/admin/tickets/${id}/assign`, { assigneeId }),
      update: (
        id: string,
        body: {
          status?: AdminTicketStatus;
          priority?: AdminTicketPriority;
          category?: AdminTicketCategory;
        },
      ) => client.patch<unknown>(`/admin/tickets/${id}`, body),
      escalate: (id: string, reason: string, assigneeId?: string) =>
        client.post<unknown>(`/admin/tickets/${id}/escalate`, {
          reason,
          ...(assigneeId ? { assigneeId } : {}),
        }),
    },
    reviews: {
      reports: (q: AdminPageQuery & { status?: 'OPEN' | 'UPHELD' | 'DISMISSED' } = {}) =>
        paged<AdminReportedReview>('/admin/reviews/reports', q),
      moderate: (id: string, action: 'hide' | 'unhide', reason: string) =>
        client.post<unknown>(`/admin/reviews/${id}/${action}`, r(reason)),
    },
    iam: {
      roles: () => client.get<AdminRole[]>('/admin/roles'),
      permissions: () => client.get<AdminPermission[]>('/admin/permissions'),
    },
    audit: {
      list: (
        q: AdminPageQuery & {
          actor?: string;
          targetType?: string;
          targetId?: string;
          action?: string;
          sensitivity?: 'NORMAL' | 'HIGH';
          from?: string;
          to?: string;
        } = {},
      ) => paged<AdminAuditLog>('/admin/audit-logs', q),
    },
    jobs: {
      failed: (queue?: string, limit = 50) =>
        get<AdminFailedJob[]>('/admin/jobs/failed', { queue, limit }),
      retry: (queue: string, jobId: string, reason: string) =>
        client.post<{ queue: string; jobId: string; retried: boolean }>(
          `/admin/jobs/${queue}/${encodeURIComponent(jobId)}/retry`,
          r(reason),
        ),
    },
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
