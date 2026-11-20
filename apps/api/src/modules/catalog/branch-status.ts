import { localParts, toMinutes, zonedInstant } from './local-time';

export type BranchState = 'OPEN' | 'CLOSING_SOON' | 'CLOSED' | 'PAUSED' | 'UNAVAILABLE';
export type BranchStatusReason =
  | 'NOT_LISTED'
  | 'ZONE_SUSPENDED'
  | 'FSSAI_EXPIRED'
  | 'PAUSED'
  | 'MANUALLY_CLOSED'
  | 'HOLIDAY'
  | 'OUTSIDE_HOURS'
  | 'LAST_ORDER_CUTOFF';

export interface BranchStatusInput {
  now: Date;
  timezone: string;
  restaurant: { status: string; onboardingStatus: string; fssaiExpiresOn: Date | null };
  branch: {
    status: string;
    deletedAt: Date | null;
    isOpenManual: boolean;
    pausedUntil: Date | null;
    defaultPrepMinutes: number;
  };
  zoneStatus: string;
  /** weekday 0 = Sunday; times "HH:MM" or Prisma TIME values; closes ≤ opens means the slot crosses midnight. */
  hours: { weekday: number; opensAt: string | Date; closesAt: string | Date }[];
  holidays: { startsAt: Date; endsAt: Date }[];
}

export interface BranchStatus {
  state: BranchState;
  /** BR-REST-001: true only when a new order may be placed right now. */
  acceptingOrders: boolean;
  reason: BranchStatusReason | null;
  /** Next time orders open (null when unknown, e.g. manually closed or FSSAI expired). */
  opensAt: Date | null;
  /** BR-REST-004 last-order time of the current slot, when open. */
  lastOrderAt: Date | null;
}

export const CLOSING_SOON_MINUTES = 30; // FR-MENUC-001
const MIN_CUTOFF_MINUTES = 15; // BR-REST-004

interface Interval {
  start: Date;
  end: Date;
}

/** Operating intervals from yesterday through the next 7 days, as instants. */
export function operatingIntervals(
  input: Pick<BranchStatusInput, 'now' | 'timezone' | 'hours'>,
): Interval[] {
  const today = localParts(input.now, input.timezone);
  const intervals: Interval[] = [];
  for (let offset = -1; offset <= 7; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = date.getUTCDay();
    for (const slot of input.hours.filter((h) => h.weekday === weekday)) {
      const opens = toMinutes(slot.opensAt);
      let closes = toMinutes(slot.closesAt);
      if (closes <= opens) closes += 24 * 60; // crosses midnight (BR-REST-003)
      const y = date.getUTCFullYear();
      const m = date.getUTCMonth() + 1;
      const d = date.getUTCDate();
      intervals.push({
        start: zonedInstant(y, m, d, opens, input.timezone),
        end: zonedInstant(y, m, d, closes, input.timezone),
      });
    }
  }
  return intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const within = (t: Date, h: { startsAt: Date; endsAt: Date }) => t >= h.startsAt && t < h.endsAt;

/**
 * Computes whether a branch accepts orders now (BR-REST-001, BR-REST-004) and
 * what to tell the customer (FR-MENUC-001). Pure: all inputs are passed in.
 */
export function computeBranchStatus(input: BranchStatusInput): BranchStatus {
  const { now, restaurant, branch } = input;
  const closed = (
    state: BranchState,
    reason: BranchStatusReason,
    opensAt: Date | null = null,
  ): BranchStatus => ({
    state,
    acceptingOrders: false,
    reason,
    opensAt,
    lastOrderAt: null,
  });

  if (
    restaurant.onboardingStatus !== 'APPROVED' ||
    restaurant.status !== 'ACTIVE' ||
    branch.status !== 'ACTIVE' ||
    branch.deletedAt
  ) {
    return closed('UNAVAILABLE', 'NOT_LISTED');
  }
  if (input.zoneStatus !== 'ACTIVE') return closed('CLOSED', 'ZONE_SUSPENDED');

  // BR-REST-011: expired on or before today's local date.
  if (restaurant.fssaiExpiresOn) {
    const today = localParts(now, input.timezone);
    const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
    if (restaurant.fssaiExpiresOn.getTime() < todayUtc) return closed('PAUSED', 'FSSAI_EXPIRED');
  }

  const cutoffMs = Math.max(branch.defaultPrepMinutes, MIN_CUTOFF_MINUTES) * 60_000;
  const intervals = operatingIntervals(input);

  /** First instant ≥ `from` at which orders are accepted (holidays and cutoff respected). */
  const nextOpening = (from: Date): Date | null => {
    for (const interval of intervals) {
      let t = interval.start > from ? interval.start : from;
      for (const holiday of input.holidays) if (within(t, holiday)) t = holiday.endsAt;
      if (t.getTime() < interval.end.getTime() - cutoffMs) return t;
    }
    return null;
  };

  if (!branch.isOpenManual) return closed('CLOSED', 'MANUALLY_CLOSED');
  if (branch.pausedUntil && branch.pausedUntil > now) {
    return closed('PAUSED', 'PAUSED', nextOpening(branch.pausedUntil));
  }
  if (input.holidays.some((h) => within(now, h)))
    return closed('CLOSED', 'HOLIDAY', nextOpening(now));

  const current = intervals.find((i) => now >= i.start && now < i.end);
  if (!current) return closed('CLOSED', 'OUTSIDE_HOURS', nextOpening(now));

  // A holiday starting later in this slot ends it early.
  const holidayStart = input.holidays
    .map((h) => h.startsAt)
    .filter((s) => s > now && s < current.end)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const effectiveEnd = holidayStart ?? current.end;
  const lastOrderAt = new Date(effectiveEnd.getTime() - cutoffMs);
  if (now >= lastOrderAt) return closed('CLOSED', 'LAST_ORDER_CUTOFF', nextOpening(effectiveEnd));

  const closingSoon = lastOrderAt.getTime() - now.getTime() <= CLOSING_SOON_MINUTES * 60_000;
  return {
    state: closingSoon ? 'CLOSING_SOON' : 'OPEN',
    acceptingOrders: true,
    reason: null,
    opensAt: null,
    lastOrderAt,
  };
}
