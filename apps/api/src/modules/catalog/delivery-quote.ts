/**
 * Listing-time delivery numbers (FR-DISC-009/010). These are previews: the
 * binding fee is computed by the pricing engine at checkout (Phase 6), from
 * the same fee schedule.
 */

export interface FeeScheduleView {
  id: string;
  slabs: { fromM: number; toM: number; feeAmount: number }[];
  perKmBeyondSlabsAmount: number;
  smallOrderThresholdAmount: number;
  smallOrderFeeAmount: number;
  platformFeeAmount: number;
  surgeCapAmount: number;
}

/** BR-PRICE-003: slab fee; beyond the last slab, last fee + per started km. */
export function deliveryFeeFor(distanceM: number, schedule: FeeScheduleView): number {
  const slabs = [...schedule.slabs].sort((a, b) => a.fromM - b.fromM);
  const slab = slabs.find((s) => distanceM >= s.fromM && distanceM < s.toM);
  if (slab) return slab.feeAmount;
  const last = slabs.at(-1);
  if (!last) return 0;
  if (distanceM < (slabs[0]?.fromM ?? 0)) return slabs[0]?.feeAmount ?? 0;
  return (
    last.feeAmount + Math.ceil((distanceM - last.toM) / 1000) * schedule.perKmBeyondSlabsAmount
  );
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
