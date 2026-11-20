import { describe, expect, it } from 'vitest';
import { redact } from './audit.service';

describe('audit redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    expect(
      redact({
        email: 'a@example.com',
        passwordHash: 'x',
        nested: { refreshToken: 'y', ok: 1 },
        list: [{ otp: '123456' }],
      }),
    ).toEqual({
      email: 'a@example.com',
      passwordHash: '[REDACTED]',
      nested: { refreshToken: '[REDACTED]', ok: 1 },
      list: [{ otp: '[REDACTED]' }],
    });
  });
});
