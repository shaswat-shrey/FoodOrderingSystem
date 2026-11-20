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

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
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
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/** "123.5" (rupees, as typed) → paise; '' → null. */
export function toPaise(rupeesText: string): number | null {
  if (rupeesText.trim() === '') return null;
  return Math.round(Number(rupeesText) * 100);
}

/** Paise → the rupee text an input shows. */
export function fromPaise(paise: number | null | undefined): string {
  return paise == null ? '' : String(paise / 100);
}

export function label(code: string): string {
  const s = code.toLowerCase().replaceAll('_', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Stale-version answers from If-Match writes (API-RMENU-009). */
export function isVersionConflict(error: unknown): boolean {
  const e = error as { code?: string; status?: number } | null;
  return Boolean(
    e && (e.code === 'CONFLICT_STALE_VERSION' || e.status === 409 || e.status === 412),
  );
}
