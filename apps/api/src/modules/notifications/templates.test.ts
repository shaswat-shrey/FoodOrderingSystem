import { describe, expect, it } from 'vitest';
import { render } from './templates';

describe('message templates', () => {
  it('renders OTP text with the code, purpose and expiry', () => {
    const { text } = render({
      template: 'OTP',
      vars: { code: '482913', purpose: 'LOGIN', minutes: 5 },
    });
    expect(text).toContain('482913');
    expect(text).toContain('sign in');
    expect(text).toContain('5 minutes');
  });

  it('renders security alerts', () => {
    expect(
      render({
        template: 'SECURITY_ALERT',
        vars: { name: 'Asha', event: 'SESSION_REUSE_DETECTED' },
      }).text,
    ).toMatch(/signed out/);
  });
});
