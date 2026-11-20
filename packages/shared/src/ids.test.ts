import { describe, expect, it } from 'vitest';
import { uuidv7, uuidv7Timestamp } from './ids';

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 UUIDs', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('encodes the timestamp and sorts by creation time', () => {
    const t = Date.UTC(2026, 10, 20, 12, 0, 0);
    expect(uuidv7Timestamp(uuidv7(t))).toBe(t);
    const ids = [uuidv7(t), uuidv7(t + 1), uuidv7(t + 1000), uuidv7(t + 86_400_000)];
    expect([...ids].sort()).toEqual(ids);
  });

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7()));
    expect(ids.size).toBe(10_000);
  });
});
