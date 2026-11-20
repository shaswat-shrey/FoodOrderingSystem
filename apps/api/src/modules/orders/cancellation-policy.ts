import { createHmac } from 'node:crypto';
import type { CancellationFault, OrderStatus } from '@fos/db';
import { money, percentOf } from '@fos/shared';

export type NotAllowedReason = 'ORDER_READY' | 'ORDER_PICKED_UP' | 'ORDER_CLOSED';

export interface CustomerTerms {
  allowed: boolean;
  reason?: NotAllowedReason;
  /** Fee by policy before capping at what was paid. */
  policyFee: number;
  /** When an ACCEPTED order's free window ends (BR-ORDER-011). */
  freeUntil: Date | null;
}

export interface PolicyInput {
  status: OrderStatus;
  acceptedAt: Date | null;
  /** Items subtotal after item discounts, promotions and coupon. */
  foodValue: number;
  packaging: number;
  now: Date;
  freeWindowSeconds: number;
  acceptedFeeBps: number;
}

/** BR-ORDER-010…013: may the customer cancel, and what does policy charge? */
export function customerTerms(p: PolicyInput): CustomerTerms {
  switch (p.status) {
    case 'PAYMENT_PENDING':
    case 'PLACED':
      return { allowed: true, policyFee: 0, freeUntil: null };
    case 'ACCEPTED': {
      const freeUntil = new Date((p.acceptedAt ?? p.now).getTime() + p.freeWindowSeconds * 1000);
      return {
        allowed: true,
        policyFee: p.now < freeUntil ? 0 : percentOf(money(p.foodValue), p.acceptedFeeBps).amount,
        freeUntil,
      };
    }
    case 'PREPARING':
      return { allowed: true, policyFee: p.foodValue + p.packaging, freeUntil: null };
    case 'READY_FOR_PICKUP':
      return { allowed: false, reason: 'ORDER_READY', policyFee: 0, freeUntil: null };
    case 'PICKED_UP':
      return { allowed: false, reason: 'ORDER_PICKED_UP', policyFee: 0, freeUntil: null };
    default:
      return { allowed: false, reason: 'ORDER_CLOSED', policyFee: 0, freeUntil: null };
  }
}

export interface Paid {
  /** Captured online and not yet refunded, per payment. */
  online: { paymentId: string; amount: number }[];
  /** Wallet amount already consumed by the order (0 while only held). */
  wallet: number;
  tip: number;
}

export interface Allocation {
  fee: number;
  /** Refunds to the original method, per payment. */
  toSource: { paymentId: string; amount: number }[];
  toWallet: number;
  total: number;
}

/**
 * BR-REFUND-001/002: refund = paid − fee, tip always refunded. The fee is
 * taken from wallet money first so as much as possible goes back to the
 * customer's original method.
 */
export function allocate(paid: Paid, policyFee: number): Allocation {
  const onlineTotal = paid.online.reduce((s, p) => s + p.amount, 0);
  const total = onlineTotal + paid.wallet;
  const fee = Math.max(0, Math.min(policyFee, total - paid.tip));
  const fromWallet = Math.min(fee, paid.wallet);
  let fromOnline = fee - fromWallet;
  const toSource = paid.online
    .map((p) => {
      const keep = Math.min(fromOnline, p.amount);
      fromOnline -= keep;
      return { paymentId: p.paymentId, amount: p.amount - keep };
    })
    .filter((p) => p.amount > 0);
  const toWallet = paid.wallet - fromWallet;
  return { fee, toSource, toWallet, total: total - fee };
}

/** Fault for each non-customer cancel path when the caller doesn't say (BR-ORDER-016). */
export const DEFAULT_FAULT: Record<string, CancellationFault> = {
  ACCEPT_TIMEOUT: 'RESTAURANT',
};

/**
 * FR-ORDER-020: the quote id is derived from everything the terms depend on,
 * so it changes exactly when the terms would. Nothing needs storing.
 */
export function quoteIdFor(
  secret: string,
  parts: { orderId: string; version: number; fee: number; refund: number },
): string {
  const h = createHmac('sha256', secret)
    .update(`cancel-quote|${parts.orderId}|${parts.version}|${parts.fee}|${parts.refund}`)
    .digest('hex');
  // UUID-shaped (version 8: custom) so it fits order_cancellations.quote_id; the
  // last group starts with the order version in clear so a stale quote can say why.
  const v = (parts.version & 0xffff).toString(16).padStart(4, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${v}${h.slice(20, 28)}`;
}

/** The order version a quote was made for (see quoteIdFor). */
export function quoteVersion(quoteId: string): number {
  return parseInt(quoteId.slice(24, 28), 16);
}
