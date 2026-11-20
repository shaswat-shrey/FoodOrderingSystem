/** ₹ from paise, Indian grouping, no decimals when whole. */
export function rupees(paise: number | null | undefined): string {
  if (paise == null) return '—';
  const r = paise / 100;
  return `${r < 0 ? '−' : ''}₹${Math.abs(r).toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(r) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

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

/** Basis points as a percentage: 1850 → "18.5%". */
export const bps = (v: number | null | undefined) => (v == null ? '—' : `${v / 100}%`);

/** UPPER_SNAKE → "Upper snake". */
export function label(code: string | null | undefined): string {
  if (!code) return '—';
  const s = code.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Rupees typed by an admin → paise (NaN when not a number). */
export function toPaise(input: string): number {
  const n = Number(input.trim());
  return Number.isFinite(n) && input.trim() !== '' ? Math.round(n * 100) : NaN;
}

export const short = (id: string) => id.slice(0, 8);

export function json(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value);
}
