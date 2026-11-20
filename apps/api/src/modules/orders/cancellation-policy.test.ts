import { describe, expect, it } from 'vitest';
import { allocate, customerTerms, quoteIdFor, quoteVersion } from './cancellation-policy';

const now = new Date('2026-11-20T08:00:00Z');
const base = {
  acceptedAt: null,
  foodValue: 40_000,
  packaging: 2_000,
  now,
  freeWindowSeconds: 60,
  acceptedFeeBps: 5000,
};

describe('customer cancellation terms (BR-ORDER-010…013)', () => {
  it('is free before acceptance', () => {
    expect(customerTerms({ ...base, status: 'PLACED' })).toMatchObject({
      allowed: true,
      policyFee: 0,
    });
    expect(customerTerms({ ...base, status: 'PAYMENT_PENDING' }).policyFee).toBe(0);
  });

  it('is free for 60 s after acceptance, then half the food value', () => {
    const inWindow = customerTerms({
      ...base,
      status: 'ACCEPTED',
      acceptedAt: new Date(now.getTime() - 59_000),
    });
    expect(inWindow).toMatchObject({ allowed: true, policyFee: 0 });
    expect(inWindow.freeUntil!.getTime()).toBe(now.getTime() + 1_000);
    const late = customerTerms({
      ...base,
      status: 'ACCEPTED',
      acceptedAt: new Date(now.getTime() - 60_000),
    });
    expect(late.policyFee).toBe(20_000);
  });

  it('charges food and packaging while preparing, and refuses later', () => {
    expect(customerTerms({ ...base, status: 'PREPARING' }).policyFee).toBe(42_000);
    expect(customerTerms({ ...base, status: 'READY_FOR_PICKUP' })).toMatchObject({
      allowed: false,
      reason: 'ORDER_READY',
    });
    expect(customerTerms({ ...base, status: 'PICKED_UP' }).reason).toBe('ORDER_PICKED_UP');
    expect(customerTerms({ ...base, status: 'DELIVERED' }).reason).toBe('ORDER_CLOSED');
  });
});

describe('refund allocation (BR-REFUND-001/002)', () => {
  it('takes the fee from wallet money first and always refunds the tip', () => {
    expect(
      allocate({ online: [{ paymentId: 'p', amount: 50_000 }], wallet: 5_000, tip: 3_000 }, 20_000),
    ).toEqual({
      fee: 20_000,
      toSource: [{ paymentId: 'p', amount: 35_000 }],
      toWallet: 0,
      total: 35_000,
    });
    expect(
      allocate({ online: [{ paymentId: 'p', amount: 10_000 }], wallet: 0, tip: 3_000 }, 50_000),
    ).toMatchObject({ fee: 7_000, toSource: [{ paymentId: 'p', amount: 3_000 }] });
  });

  it('charges nothing when nothing was paid (COD)', () => {
    expect(allocate({ online: [], wallet: 0, tip: 0 }, 20_000)).toEqual({
      fee: 0,
      toSource: [],
      toWallet: 0,
      total: 0,
    });
  });
});

describe('quote ids (FR-ORDER-020)', () => {
  it('are stable for the same terms and change with them', () => {
    const a = quoteIdFor('s', { orderId: 'o', version: 3, fee: 0, refund: 100 });
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(quoteIdFor('s', { orderId: 'o', version: 3, fee: 0, refund: 100 })).toBe(a);
    expect(quoteIdFor('s', { orderId: 'o', version: 4, fee: 0, refund: 100 })).not.toBe(a);
    expect(quoteIdFor('s', { orderId: 'o', version: 3, fee: 50, refund: 50 })).not.toBe(a);
    expect(quoteVersion(a)).toBe(3);
  });
});
