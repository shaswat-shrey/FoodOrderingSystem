import { describe, expect, it } from 'vitest';
import { DEFAULT_ERROR_MESSAGES, ERROR_CODES } from './errors';

describe('error catalogue', () => {
  it('has a customer-facing default message for every error code', () => {
    const missing = Object.keys(ERROR_CODES).filter(
      (code) => !DEFAULT_ERROR_MESSAGES[code as keyof typeof ERROR_CODES],
    );
    expect(missing).toEqual([]);
  });
});
