import type { PartnerPayPlan } from '@fos/db';

export interface TripFacts {
  /** Road metres restaurant → customer. */
  dropRoadM: number;
  /** Minutes the partner waited at the restaurant (arrival → pickup). */
  waitMinutes: number;
  /** Zone surge/rain bonus active when the trip ended. */
  surge: boolean;
}

export interface Pay {
  base: number;
  distance: number;
  wait: number;
  surge: number;
}

type Plan = Pick<
  PartnerPayPlan,
  | 'baseAmount'
  | 'perKmAmount'
  | 'freeKmM'
  | 'waitAfterMinutes'
  | 'perWaitMinuteAmount'
  | 'waitCapAmount'
  | 'rainBonusAmount'
  | 'cancellationMinAmount'
>;

/** BR-EARN-001: base + per km beyond the free distance + waiting beyond the grace (capped) + surge. */
export function tripPay(plan: Plan, t: TripFacts): Pay {
  const extraKm = Math.max(0, t.dropRoadM - plan.freeKmM) / 1000;
  return {
    base: plan.baseAmount,
    distance: Math.round(extraKm * plan.perKmAmount),
    wait: Math.min(
      plan.waitCapAmount,
      Math.max(0, Math.floor(t.waitMinutes - plan.waitAfterMinutes)) * plan.perWaitMinuteAmount,
    ),
    surge: t.surge ? plan.rainBonusAmount : 0,
  };
}

/**
 * BR-EARN-007: cancelled before pickup (not the partner's fault) → base pay
 * plus the distance already ridden toward the restaurant, at least the minimum;
 * after pickup → the full trip.
 */
export function cancellationPay(
  plan: Plan,
  input: { stage: 'BEFORE_PICKUP' | 'AFTER_PICKUP'; travelledM: number; trip: TripFacts },
): Pay {
  if (input.stage === 'AFTER_PICKUP') return tripPay(plan, input.trip);
  const distance = Math.round((input.travelledM / 1000) * plan.perKmAmount);
  const total = Math.max(plan.cancellationMinAmount, plan.baseAmount + distance);
  return { base: total - distance, distance, wait: 0, surge: 0 };
}

export const payTotal = (p: Pay) => p.base + p.distance + p.wait + p.surge;
