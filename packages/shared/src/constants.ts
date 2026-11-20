/** Client applications; sent as `X-Client-App` and used as JWT audience (SRS §14.1). */
export const CLIENT_APPS = ['CUSTOMER', 'RESTAURANT', 'DELIVERY', 'ADMIN'] as const;
export type ClientApp = (typeof CLIENT_APPS)[number];

/** BullMQ queue names (docs/architecture/EVENTS-AND-JOBS.md §3). */
export const QUEUE_NAMES = [
  'notifications',
  'orders',
  'dispatch',
  'payments',
  'refunds',
  'tracking',
  'payouts',
  'analytics',
  'maintenance',
  'files',
  'reports',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Socket.IO namespaces, one per client app (FR-RT-001). */
export const SOCKET_NAMESPACES: Record<ClientApp, string> = {
  CUSTOMER: '/customer',
  RESTAURANT: '/restaurant',
  DELIVERY: '/delivery',
  ADMIN: '/admin',
};

export const API_PREFIX = '/api/v1';
export const REQUEST_ID_HEADER = 'x-request-id';
export const CLIENT_APP_HEADER = 'x-client-app';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
