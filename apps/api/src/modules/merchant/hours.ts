import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');

export const slotSchema = z
  .object({ weekday: z.number().int().min(0).max(6), opensAt: hhmm, closesAt: hhmm })
  .strict()
  .refine((s) => s.opensAt !== s.closesAt, 'Opening and closing times must differ');

export type Slot = z.infer<typeof slotSchema>;

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * BR-REST-003: ≤ 3 slots per weekday, slots may cross midnight, slots of the
 * same day don't overlap (a crossing slot is checked against the next day too).
 */
export function slotProblems(slots: Slot[]): string[] {
  const problems: string[] = [];
  for (let day = 0; day < 7; day++) {
    const own = slots.filter((s) => s.weekday === day);
    if (own.length > 3) problems.push(`Day ${day}: at most 3 slots`);
  }
  // Week as minutes 0…10080, crossing slots extend into the next day.
  const spans = slots
    .map((s) => {
      const start = s.weekday * 1440 + minutes(s.opensAt);
      let end = s.weekday * 1440 + minutes(s.closesAt);
      if (end <= start) end += 1440;
      return { s, start, end };
    })
    .flatMap((x) =>
      x.end > 10_080 ? [x, { ...x, start: x.start - 10_080, end: x.end - 10_080 }] : [x],
    )
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1]!;
    const b = spans[i]!;
    if (a.s !== b.s && b.start < a.end)
      problems.push(
        `Slots overlap: day ${a.s.weekday} ${a.s.opensAt}–${a.s.closesAt} and day ${b.s.weekday} ${b.s.opensAt}–${b.s.closesAt}`,
      );
  }
  return [...new Set(problems)];
}

export const weeklyHoursSchema = z
  .array(slotSchema)
  .max(21)
  .superRefine((slots, ctx) => {
    for (const message of slotProblems(slots)) ctx.addIssue({ code: 'custom', message });
  });

/** Postgres TIME values as Prisma reads and writes them. */
export const toTime = (t: string) => new Date(`1970-01-01T${t}:00.000Z`);
export const fromTime = (d: Date) => d.toISOString().slice(11, 16);
