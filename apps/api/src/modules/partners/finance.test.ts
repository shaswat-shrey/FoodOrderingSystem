import { describe, expect, it } from 'vitest';
import { periodBounds } from './finance.service';

describe('earnings periods (BR-EARN-004: IST, Monday–Sunday weeks)', () => {
  // Wednesday 2026-11-18 23:30 IST = 18:00 UTC.
  const at = new Date('2026-11-18T18:00:00Z');
  it('uses the local day, week and month', () => {
    expect(periodBounds('day', at)).toEqual({
      from: new Date('2026-11-17T18:30:00Z'),
      to: new Date('2026-11-18T18:30:00Z'),
    });
    expect(periodBounds('week', at)).toEqual({
      from: new Date('2026-11-15T18:30:00Z'), // Monday 16 Nov 00:00 IST
      to: new Date('2026-11-22T18:30:00Z'),
    });
    expect(periodBounds('month', at)).toEqual({
      from: new Date('2026-10-31T18:30:00Z'),
      to: new Date('2026-11-30T18:30:00Z'),
    });
  });
  it('puts Sunday in the week that started the Monday before, and rolls December over', () => {
    const sunday = new Date('2026-11-22T10:00:00Z');
    expect(periodBounds('week', sunday).from).toEqual(new Date('2026-11-15T18:30:00Z'));
    expect(periodBounds('month', new Date('2026-12-10T00:00:00Z')).to).toEqual(
      new Date('2026-12-31T18:30:00Z'),
    );
  });
});
