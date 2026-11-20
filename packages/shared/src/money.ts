/**
 * Money helpers (ADR-007, BR-PRICE-002).
 *
 * All amounts are integer minor units (paise for INR). Floating point is never
 * used for money: percentages are expressed in basis points (1 bp = 0.01 %) and
 * rounded once, half-up, with integer arithmetic.
 */

export type CurrencyCode = 'INR';

export interface Money {
  /** Integer minor units (paise). */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/** Throws unless `value` is a safe integer number of minor units. */
export function assertMinorUnits(value: number, label = 'amount'): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer number of minor units, got ${value}`);
  }
}

export function money(amount: number, currency: CurrencyCode = 'INR'): Money {
  assertMinorUnits(amount);
  return { amount, currency };
}

/** Converts whole rupees (integer) to paise. */
export function rupees(value: number): Money {
  assertMinorUnits(value, 'rupees');
  return money(value * 100);
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(...values: Money[]): Money {
  const [first, ...rest] = values;
  if (!first) throw new MoneyError('add() needs at least one value');
  return rest.reduce((acc, v) => {
    sameCurrency(acc, v);
    return money(acc.amount + v.amount, acc.currency);
  }, first);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function multiply(a: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity)) {
    throw new MoneyError(`quantity must be an integer, got ${quantity}`);
  }
  return money(a.amount * quantity, a.currency);
}

/**
 * Integer division rounded half-up (away from zero for the half case),
 * computed without floating point.
 */
function divideRoundHalfUp(numerator: number, denominator: number): number {
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const quotient = Math.floor(n / d);
  const remainder = n - quotient * d;
  const rounded = remainder * 2 >= d ? quotient + 1 : quotient;
  return sign * rounded;
}

/**
 * Applies a rate in basis points: 500 bps = 5 %. Rounded half-up to the paisa,
 * e.g. 5 % of ₹10.10 (1010 paise) = 50.5 → 51 paise.
 */
export function percentOf(base: Money, rateBps: number): Money {
  if (!Number.isSafeInteger(rateBps) || rateBps < 0) {
    throw new MoneyError(`rateBps must be a non-negative integer, got ${rateBps}`);
  }
  const product = base.amount * rateBps;
  if (!Number.isSafeInteger(product)) {
    throw new MoneyError('Amount too large for basis-point calculation');
  }
  return money(divideRoundHalfUp(product, 10_000), base.currency);
}

/** Returns the smaller of two amounts (used for discount caps). */
export function min(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return a.amount <= b.amount ? a : b;
}

export function isZero(a: Money): boolean {
  return a.amount === 0;
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Display formatting only — never parse the result back into money. */
export function formatMoney(value: Money): string {
  // Division here is for display; the stored value stays an integer.
  return inrFormatter.format(value.amount / 100);
}
