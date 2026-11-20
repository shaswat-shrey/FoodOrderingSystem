import { describe, expect, it } from 'vitest';
import {
  add,
  formatMoney,
  min,
  money,
  MoneyError,
  multiply,
  percentOf,
  rupees,
  subtract,
} from './money';

describe('money (ADR-007)', () => {
  it('rejects non-integer minor units', () => {
    expect(() => money(10.5)).toThrow(MoneyError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
  });

  it('converts rupees to paise', () => {
    expect(rupees(149).amount).toBe(14_900);
  });

  it('adds, subtracts and multiplies exactly', () => {
    // 0.1 + 0.2 style float errors cannot occur with integer paise.
    expect(add(money(10), money(20), money(30)).amount).toBe(60);
    expect(subtract(money(1000), money(1)).amount).toBe(999);
    expect(multiply(money(24_900), 3).amount).toBe(74_700);
    expect(() => multiply(money(100), 1.5)).toThrow(MoneyError);
  });

  it('BR-PRICE-002 applies basis points with half-up rounding', () => {
    expect(percentOf(money(1010), 500).amount).toBe(51); // 50.5 → 51
    expect(percentOf(money(1009), 500).amount).toBe(50); // 50.45 → 50
    expect(percentOf(money(40_000), 2000).amount).toBe(8000); // 20 % commission
    expect(percentOf(money(0), 1800).amount).toBe(0);
    expect(percentOf(money(-1010), 500).amount).toBe(-51); // symmetric for refunds
  });

  it('rejects invalid rates', () => {
    expect(() => percentOf(money(100), -1)).toThrow(MoneyError);
    expect(() => percentOf(money(100), 2.5)).toThrow(MoneyError);
  });

  it('picks the smaller amount for caps', () => {
    expect(min(money(500), money(300)).amount).toBe(300);
  });

  it('formats INR for display', () => {
    expect(formatMoney(money(123_450))).toBe('₹1,234.50');
    expect(formatMoney(money(1_00_00_000))).toBe('₹1,00,000.00');
  });

  it('property: percentOf never differs from the exact value by more than half a paisa', () => {
    for (let amount = 0; amount < 5000; amount += 7) {
      for (const bps of [0, 1, 250, 500, 1800, 2000, 9999, 10_000]) {
        const exact = (amount * bps) / 10_000;
        expect(Math.abs(percentOf(money(amount), bps).amount - exact)).toBeLessThanOrEqual(0.5);
      }
    }
  });
});
