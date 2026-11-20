/**
 * Listing-time delivery numbers (FR-DISC-009/010). These are previews: the
 * binding fee is computed by the pricing engine at checkout (Phase 6), from
 * the same fee schedule.
 */

import { slabFee, type FeeConfig } from '../pricing';

/** The effective fee schedule: the same view the pricing engine uses. */
export type FeeScheduleView = FeeConfig;

/** BR-PRICE-003 (shared with the pricing engine). */
export function deliveryFeeFor(distanceM: number, schedule: FeeScheduleView): number {
  return slabFee(distanceM, schedule);
}

/** BR-PRICE-007: zone surge while active, never above the schedule's cap. */
export function surgeFor(
  zone: { surgeAmount: number; surgeUntil: Date | null; surgeReason: string | null },
  capAmount: number,
  now: Date,
): { amount: number; reason: string | null } {
  if (zone.surgeAmount <= 0 || !zone.surgeUntil || zone.surgeUntil <= now)
    return { amount: 0, reason: null };
  return { amount: Math.min(zone.surgeAmount, capAmount), reason: zone.surgeReason };
}

/**
 * FR-DISC-010: prep (14-day average, else configured) + rush extra + travel +
 * buffer, ± range, rounded to 5 minutes (never below 5).
 */
export function etaRange(input: {
  prepMinutes: number;
  rushExtraMinutes: number;
  travelSeconds: number;
  bufferMinutes: number;
  rangeMinutes: number;
}): { minMinutes: number; maxMinutes: number } {
  const centre =
    input.prepMinutes + input.rushExtraMinutes + input.travelSeconds / 60 + input.bufferMinutes;
  const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);
  return {
    minMinutes: round5(centre - input.rangeMinutes),
    maxMinutes: round5(centre + input.rangeMinutes),
  };
}
