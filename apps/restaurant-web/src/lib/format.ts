/** ₹ from paise, Indian grouping, no decimals when whole. */
export function rupees(paise: number | null | undefined): string {
  if (paise == null) return '—';
  const r = paise / 100;
  return `₹${r.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
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

/** "12:05" style elapsed/remaining time from seconds. */
export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function minutes(seconds: number | null | undefined): string {
  return seconds == null ? '—' : `${Math.round(seconds / 60)} min`;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  ORDER_MANAGER: 'Order manager',
  KITCHEN: 'Kitchen',
  STAFF: 'Staff',
};
