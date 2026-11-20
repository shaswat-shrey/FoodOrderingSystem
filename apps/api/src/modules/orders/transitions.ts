import type { OrderStatus } from '@fos/db';

export type OrderActor = 'CUSTOMER' | 'RESTAURANT' | 'PARTNER' | 'ADMIN' | 'SYSTEM';

export interface TransitionRule {
  id: string;
  from: OrderStatus;
  to: OrderStatus;
  actors: OrderActor[];
}

/**
 * SRS §10.3 formal transition table (T01/T02 are creation, not transitions).
 * Anything not listed — including every move out of a terminal state — is
 * rejected with ORDER_INVALID_TRANSITION.
 */
export const TRANSITIONS: readonly TransitionRule[] = [
  { id: 'T03', from: 'PAYMENT_PENDING', to: 'PLACED', actors: ['SYSTEM'] },
  { id: 'T04', from: 'PAYMENT_PENDING', to: 'FAILED', actors: ['SYSTEM'] },
  { id: 'T05', from: 'PAYMENT_PENDING', to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN'] },
  { id: 'T06', from: 'PLACED', to: 'ACCEPTED', actors: ['RESTAURANT'] },
  { id: 'T07', from: 'PLACED', to: 'REJECTED', actors: ['RESTAURANT'] },
  { id: 'T08', from: 'PLACED', to: 'CANCELLED', actors: ['CUSTOMER', 'SYSTEM', 'ADMIN'] },
  { id: 'T09', from: 'ACCEPTED', to: 'PREPARING', actors: ['RESTAURANT', 'SYSTEM'] },
  {
    id: 'T10',
    from: 'ACCEPTED',
    to: 'CANCELLED',
    actors: ['CUSTOMER', 'RESTAURANT', 'ADMIN', 'SYSTEM'],
  },
  { id: 'T11', from: 'PREPARING', to: 'READY_FOR_PICKUP', actors: ['RESTAURANT'] },
  {
    id: 'T12',
    from: 'PREPARING',
    to: 'CANCELLED',
    actors: ['CUSTOMER', 'RESTAURANT', 'ADMIN', 'SYSTEM'],
  },
  { id: 'T13', from: 'READY_FOR_PICKUP', to: 'PICKED_UP', actors: ['PARTNER', 'RESTAURANT'] },
  { id: 'T13c', from: 'PREPARING', to: 'PICKED_UP', actors: ['PARTNER', 'RESTAURANT'] },
  { id: 'T14', from: 'READY_FOR_PICKUP', to: 'CANCELLED', actors: ['ADMIN', 'SYSTEM'] },
  { id: 'T15', from: 'PICKED_UP', to: 'DELIVERED', actors: ['PARTNER', 'ADMIN'] },
  { id: 'T16', from: 'PICKED_UP', to: 'FAILED', actors: ['ADMIN'] },
];

export const TERMINAL: ReadonlySet<OrderStatus> = new Set([
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'FAILED',
]);

export function findTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: OrderActor,
): TransitionRule | null {
  const rule = TRANSITIONS.find((t) => t.from === from && t.to === to);
  return rule && rule.actors.includes(actor) ? rule : null;
}

/** Which timestamp column a target status sets. */
export const STATUS_TIMESTAMP: Partial<
  Record<
    OrderStatus,
    | 'placedAt'
    | 'acceptedAt'
    | 'preparingAt'
    | 'readyAt'
    | 'pickedUpAt'
    | 'deliveredAt'
    | 'cancelledAt'
  >
> = {
  PLACED: 'placedAt',
  ACCEPTED: 'acceptedAt',
  PREPARING: 'preparingAt',
  READY_FOR_PICKUP: 'readyAt',
  PICKED_UP: 'pickedUpAt',
  DELIVERED: 'deliveredAt',
  CANCELLED: 'cancelledAt',
  REJECTED: 'cancelledAt',
};

/** Domain event names on the outbox (EVENTS-AND-JOBS §1). */
export const eventFor = (status: OrderStatus) => `order.${status.toLowerCase()}`;
