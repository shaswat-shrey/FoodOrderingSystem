/** ₹ from paise, Indian grouping, no decimals when whole. */
export function rupees(paise: number | null | undefined): string {
  if (paise == null) return '—';
  const r = paise / 100;
  return `₹${r.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(r) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function clock(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

export const etaRange = (eta: { minMinutes: number; maxMinutes: number } | null | undefined) =>
  eta ? `${eta.minMinutes}–${eta.maxMinutes} min` : '—';

/** "updated 12 s ago" style age. */
export function ago(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

export const ratingText = (rating: { average: number | null; isNew: boolean; count: number }) =>
  rating.isNew || rating.average == null ? 'New' : `★ ${rating.average.toFixed(1)}`;

export const VEHICLE_LABEL: Record<string, string> = {
  BICYCLE: 'Bicycle',
  E_BIKE: 'E-bike',
  MOTORCYCLE: 'Motorcycle',
  SCOOTER: 'Scooter',
};

export const SERVICEABILITY_TEXT: Record<string, string> = {
  OUTSIDE_ZONE: 'We don’t deliver to this location yet.',
  OUTSIDE_RADIUS: 'This restaurant doesn’t deliver this far.',
  BRANCH_CLOSED: 'This restaurant is closed right now.',
  BRANCH_PAUSED: 'This restaurant isn’t taking orders right now.',
  ZONE_SUSPENDED: 'Deliveries in this area are paused for a while.',
};

/** Why a restaurant isn't taking orders, in plain words (API BranchStatusReason). */
const CLOSED_REASON: Record<string, string> = {
  OUTSIDE_HOURS: 'Closed now',
  LAST_ORDER_CUTOFF: 'Not taking more orders today',
  MANUALLY_CLOSED: 'Closed for today',
  HOLIDAY: 'Closed for a holiday',
  PAUSED: 'Not taking orders for a while',
  FSSAI_EXPIRED: 'Temporarily unavailable',
  ZONE_SUSPENDED: 'Deliveries paused in this area',
  NOT_LISTED: 'Unavailable',
};
export const closedReason = (reason: string | null | undefined) =>
  (reason && CLOSED_REASON[reason]) ?? 'Closed now';
