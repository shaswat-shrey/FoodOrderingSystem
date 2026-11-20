import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, fill } from './catalog';

describe('notification templates (FR-NOTIF-005)', () => {
  it('fills variables and refuses to send blanks', () => {
    expect(
      fill('Order {{number}} from {{restaurant}}', { number: 'A1', restaurant: 'Saffron' }),
    ).toBe('Order A1 from Saffron');
    expect(() => fill('Order {{number}}', {})).toThrow(/number/);
    expect(() => fill('Order {{number}}', { number: '' })).toThrow(/number/);
  });

  it('declares every variable its texts use', () => {
    for (const t of DEFAULT_TEMPLATES) {
      const used = new Set<string>();
      for (const c of Object.values(t.channels))
        for (const text of [c.subject ?? '', c.body, t.deepLink ?? ''])
          for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1]!);
      expect(
        [...used].filter((v) => !t.variables.includes(v)),
        t.key,
      ).toEqual([]);
    }
  });
});
