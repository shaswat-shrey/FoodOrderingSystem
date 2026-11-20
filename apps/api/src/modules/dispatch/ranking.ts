/** DELIVERY-ASSIGNMENT-ALGORITHM §5: candidate features and the weighted score. */
export interface CandidateFeatures {
  partnerId: string;
  /** Straight-line metres from the partner to the branch (GEOSEARCH). */
  distanceM: number;
  /** Estimated minutes to reach the branch. */
  etaMinutes: number;
  /** Minutes until the food is ready (negative = already ready). */
  minutesUntilReady: number;
  /** Minutes since the partner's last completed delivery (null = none today). */
  idleMinutes: number | null;
  acceptanceRate: number; // 0..1
  rating: number | null; // 1..5
  deliveriesToday: number;
}

export const DEFAULT_WEIGHTS = {
  eta: 0.5,
  ready: 0.15,
  idle: 0.15,
  acceptance: 0.1,
  rating: 0.05,
  load: 0.05,
};
export type Weights = typeof DEFAULT_WEIGHTS;

const clamp = (v: number) => Math.max(0, Math.min(1, v));

export interface Scored extends CandidateFeatures {
  score: number;
  breakdown: Record<keyof Weights, number>;
}

export function score(f: CandidateFeatures, w: Weights = DEFAULT_WEIGHTS): Scored {
  const parts = {
    eta: 1 - Math.min(f.etaMinutes / 20, 1),
    ready: 1 - Math.min(Math.abs(f.etaMinutes - Math.max(f.minutesUntilReady, 0)) / 15, 1),
    // No delivery yet today counts as fully idle.
    idle: f.idleMinutes === null ? 1 : Math.min(f.idleMinutes / 30, 1),
    acceptance: clamp(f.acceptanceRate),
    rating: f.rating === null ? 0.5 : clamp((f.rating - 3) / 2),
    load: 1 - Math.min(f.deliveriesToday / 25, 1),
  };
  const breakdown = Object.fromEntries(
    (Object.keys(parts) as (keyof Weights)[]).map((k) => [
      k,
      Math.round(parts[k] * w[k] * 10_000) / 10_000,
    ]),
  ) as Record<keyof Weights, number>;
  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return { ...f, score: Math.round(total * 10_000) / 10_000, breakdown };
}

/** Highest score first; ties: shorter distance, then partner id (deterministic). */
export function rank(candidates: CandidateFeatures[], w: Weights = DEFAULT_WEIGHTS): Scored[] {
  return candidates
    .map((c) => score(c, w))
    .sort(
      (a, b) =>
        b.score - a.score || a.distanceM - b.distanceM || a.partnerId.localeCompare(b.partnerId),
    );
}

/** FR-DISP-001: when to start looking for a partner. */
export function dispatchStart(input: {
  acceptedAt: Date;
  readyBy: Date | null;
  prepMinutes: number | null;
  travelMinutes: number;
  leadBufferMinutes: number;
}): Date {
  if (!input.readyBy || (input.prepMinutes ?? 0) <= 15) return input.acceptedAt;
  const t = input.readyBy.getTime() - (input.travelMinutes + input.leadBufferMinutes) * 60_000;
  return new Date(Math.max(input.acceptedAt.getTime(), t));
}

/** BR-DEL-003: cancel for want of a partner at readyAt + 30 min, or accepted + 45 min if never ready. */
export function noPartnerDeadline(input: {
  acceptedAt: Date;
  readyBy: Date | null;
  afterReadyMinutes: number;
  afterAcceptMinutes: number;
}): Date {
  const byAccept = input.acceptedAt.getTime() + input.afterAcceptMinutes * 60_000;
  if (!input.readyBy) return new Date(byAccept);
  return new Date(Math.max(input.readyBy.getTime() + input.afterReadyMinutes * 60_000, byAccept));
}
