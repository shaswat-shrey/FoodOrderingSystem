import type { PaymentStatus } from '@fos/db';

/** FR-PAY-009 precedence; FAILED/EXPIRED/CANCELLED only from states before capture. */
const RANK: Record<PaymentStatus, number> = {
  CREATED: 0,
  PENDING: 1,
  AUTHORIZED: 2,
  CAPTURED: 3,
  COLLECTED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
  FAILED: -1,
  EXPIRED: -1,
  CANCELLED: -1,
};
const TERMINAL_FAILURES = new Set<PaymentStatus>(['FAILED', 'EXPIRED', 'CANCELLED']);

/**
 * Whether moving from `current` to `incoming` is allowed. Regressions (an old
 * "authorized" arriving after "captured") are recorded but never applied.
 * A capture after FAILED/EXPIRED/CANCELLED is allowed so the money is
 * accounted for — and then refunded (BR-PAY-005).
 */
export function canTransition(current: PaymentStatus, incoming: PaymentStatus): boolean {
  if (current === incoming) return false;
  if (TERMINAL_FAILURES.has(incoming)) return RANK[current] >= 0 && RANK[current] < RANK.CAPTURED;
  if (TERMINAL_FAILURES.has(current)) return incoming === 'CAPTURED';
  return RANK[incoming] > RANK[current];
}
