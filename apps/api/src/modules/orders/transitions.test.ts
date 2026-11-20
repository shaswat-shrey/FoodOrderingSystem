import type { OrderStatus } from '@fos/db';
import { describe, expect, it } from 'vitest';
import { findTransition, TERMINAL, TRANSITIONS, type OrderActor } from './transitions';

const ALL: OrderStatus[] = [
  'PAYMENT_PENDING',
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'FAILED',
];
const ACTORS: OrderActor[] = ['CUSTOMER', 'RESTAURANT', 'PARTNER', 'ADMIN', 'SYSTEM'];

describe('order transition table (SRS §10.3)', () => {
  it.each([
    ['PAYMENT_PENDING', 'PLACED', 'SYSTEM', 'T03'],
    ['PLACED', 'ACCEPTED', 'RESTAURANT', 'T06'],
    ['PLACED', 'CANCELLED', 'CUSTOMER', 'T08'],
    ['ACCEPTED', 'PREPARING', 'SYSTEM', 'T09'],
    ['PREPARING', 'PICKED_UP', 'RESTAURANT', 'T13c'],
    ['PICKED_UP', 'DELIVERED', 'PARTNER', 'T15'],
  ] as const)('%s → %s by %s is %s', (from, to, actor, id) => {
    expect(findTransition(from, to, actor)?.id).toBe(id);
  });

  it.each([
    ['PLACED', 'PREPARING', 'RESTAURANT'], // must accept first
    ['ACCEPTED', 'READY_FOR_PICKUP', 'RESTAURANT'], // must prepare first
    ['READY_FOR_PICKUP', 'PREPARING', 'RESTAURANT'],
    ['PICKED_UP', 'CANCELLED', 'ADMIN'], // post-pickup becomes FAILED via support
    ['READY_FOR_PICKUP', 'CANCELLED', 'CUSTOMER'], // BR-ORDER-013
    ['PLACED', 'ACCEPTED', 'CUSTOMER'], // wrong actor
    ['PAYMENT_PENDING', 'PLACED', 'CUSTOMER'], // only the payment system confirms payment
  ] as const)('rejects %s → %s by %s', (from, to, actor) => {
    expect(findTransition(from, to, actor)).toBeNull();
  });

  it('allows nothing out of terminal states', () => {
    for (const from of TERMINAL)
      for (const to of ALL) for (const a of ACTORS) expect(findTransition(from, to, a)).toBeNull();
  });

  it('lets customers only cancel, and only before pickup is near (T05, T08a, T10a, T12a)', () => {
    const customer = TRANSITIONS.filter((t) => t.actors.includes('CUSTOMER'));
    expect(customer.every((t) => t.to === 'CANCELLED')).toBe(true);
    expect(customer.map((t) => t.from).sort()).toEqual([
      'ACCEPTED',
      'PAYMENT_PENDING',
      'PLACED',
      'PREPARING',
    ]);
  });
});
