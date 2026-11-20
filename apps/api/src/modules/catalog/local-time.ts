/** Wall-clock helpers for a branch's IANA time zone (no external date library). */

export interface LocalParts {
  year: number;
  month: number; // 1–12
  day: number;
  weekday: number; // 0 = Sunday … 6 = Saturday (the branch_operating_hours convention)
  minutes: number; // minutes since local midnight
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date: Date, timeZone: string): LocalParts & { second: number } {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS[parts.weekday as string] ?? 0,
    minutes: hour * 60 + Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `date`. */
function offsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    Math.floor(p.minutes / 60),
    p.minutes % 60,
    p.second,
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at local date (y, m, d) + `minutes` in `timeZone`. Day/minute overflow rolls over. */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  const first = guess - offsetMs(new Date(guess), timeZone);
  // Second pass settles DST transitions (no-op for Asia/Kolkata).
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

/** "HH:MM" → minutes. Also accepts Prisma TIME values (Date at 1970-01-01, UTC). */
export function toMinutes(value: string | Date): number {
  if (value instanceof Date) return value.getUTCHours() * 60 + value.getUTCMinutes();
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export const formatHm = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
