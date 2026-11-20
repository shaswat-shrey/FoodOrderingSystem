import { describe, expect, it } from 'vitest';
import {
  amountSchema,
  clientAppSchema,
  cursorPaginationSchema,
  indianMobileSchema,
} from './common';

describe('common schemas', () => {
  it('accepts valid Indian mobiles and rejects others', () => {
    expect(indianMobileSchema.safeParse('+919876543210').success).toBe(true);
    expect(indianMobileSchema.safeParse('9876543210').success).toBe(false);
    expect(indianMobileSchema.safeParse('+915876543210').success).toBe(false);
    expect(indianMobileSchema.safeParse('+1415555012').success).toBe(false);
  });

  it('accepts only integer, non-negative paise', () => {
    expect(amountSchema.safeParse(24_900).success).toBe(true);
    expect(amountSchema.safeParse(249.5).success).toBe(false);
    expect(amountSchema.safeParse(-1).success).toBe(false);
  });

  it('applies pagination defaults and bounds, rejecting unknown keys (DC-03)', () => {
    expect(cursorPaginationSchema.parse({})).toEqual({ limit: 20 });
    expect(cursorPaginationSchema.parse({ limit: '50' }).limit).toBe(50);
    expect(cursorPaginationSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(cursorPaginationSchema.safeParse({ sort: 'x' }).success).toBe(false);
  });

  it('knows the four client apps', () => {
    expect(clientAppSchema.options).toEqual(['CUSTOMER', 'RESTAURANT', 'DELIVERY', 'ADMIN']);
  });
});
