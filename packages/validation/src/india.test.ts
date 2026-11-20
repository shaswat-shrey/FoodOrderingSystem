import { describe, expect, it } from 'vitest';
import { fssaiSchema, gstinCheckChar, gstinSchema, ifscSchema, panSchema } from './india';

describe('Indian identifiers (FR-REST-001)', () => {
  it('validates PAN, IFSC and FSSAI formats', () => {
    expect(panSchema.parse(' abcde1234f ')).toBe('ABCDE1234F');
    expect(panSchema.safeParse('ABCD1234F').success).toBe(false);
    expect(ifscSchema.parse('hdfc0001234')).toBe('HDFC0001234');
    expect(ifscSchema.safeParse('HDFC1001234').success).toBe(false);
    expect(fssaiSchema.safeParse('12345678901234').success).toBe(true);
    expect(fssaiSchema.safeParse('1234567890123').success).toBe(false);
  });

  it('checks the GSTIN check character', () => {
    const body = '29ABCDE1234F1Z';
    const valid = body + gstinCheckChar(body);
    expect(gstinSchema.parse(valid.toLowerCase())).toBe(valid);
    const wrong = body + (valid[14] === 'A' ? 'B' : 'A');
    expect(gstinSchema.safeParse(wrong).success).toBe(false);
    // Published sample GSTIN.
    expect(gstinSchema.safeParse('27AAPFU0939F1ZV').success).toBe(true);
  });
});
