import { describe, expect, it } from 'vitest';
import { slotProblems } from './hours';

describe('operating hours (BR-REST-003)', () => {
  it('allows split days and slots past midnight', () => {
    expect(
      slotProblems([
        { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
        { weekday: 1, opensAt: '19:00', closesAt: '01:00' },
        { weekday: 2, opensAt: '11:00', closesAt: '15:00' },
      ]),
    ).toEqual([]);
  });

  it('rejects overlaps (including into the next day and Saturday into Sunday) and a 4th slot', () => {
    expect(
      slotProblems([
        { weekday: 1, opensAt: '19:00', closesAt: '02:00' },
        { weekday: 2, opensAt: '01:00', closesAt: '05:00' },
      ]),
    ).toHaveLength(1);
    expect(
      slotProblems([
        { weekday: 6, opensAt: '22:00', closesAt: '03:00' },
        { weekday: 0, opensAt: '02:00', closesAt: '06:00' },
      ]),
    ).toHaveLength(1);
    expect(
      slotProblems(
        ['08:00', '11:00', '14:00', '17:00'].map((o) => ({
          weekday: 3,
          opensAt: o,
          closesAt: `${String(Number(o.slice(0, 2)) + 2).padStart(2, '0')}:00`,
        })),
      ),
    ).toContain('Day 3: at most 3 slots');
  });
});
