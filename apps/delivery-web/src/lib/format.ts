/** ₹ from paise, Indian grouping, no decimals when whole. */
export function rupees(paise: number | null | undefined): string {
  if (paise == null) return '—';
  const r = paise / 100;
  return `₹${r.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(r) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

export function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

export function hoursMinutes(seconds: number): string {
  const m = Math.max(0, Math.round(seconds / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const percent = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);

export const VEHICLE_LABEL: Record<string, string> = {
  BICYCLE: 'Bicycle',
  E_BIKE: 'E-bike',
  MOTORCYCLE: 'Motorcycle',
  SCOOTER: 'Scooter',
};

export const STAGE_LABEL: Record<string, string> = {
  ASSIGNED: 'Head to the restaurant',
  AT_RESTAURANT: 'At the restaurant',
  EN_ROUTE_TO_CUSTOMER: 'On the way to the customer',
  AT_CUSTOMER: 'At the customer',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  FAILED: 'Not delivered',
};
