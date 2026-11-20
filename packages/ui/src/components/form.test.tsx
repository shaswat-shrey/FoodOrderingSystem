import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Alert } from './Alert';
import { FormField, Input } from './Input';
import { OtpInput } from './OtpInput';
import { PasswordInput } from './PasswordInput';

describe('form controls (NFR-ACCESS-003)', () => {
  it('links the label and the error message to the input', () => {
    render(
      <FormField id="email" label="Email" error="Enter a valid email address">
        {(aria) => <Input {...aria} />}
      </FormField>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a valid email address');
  });

  it('shows the hint when there is no error', () => {
    render(
      <FormField id="phone" label="Mobile number" hint="We'll text you a code">
        {(aria) => <Input prefix="+91" {...aria} />}
      </FormField>,
    );
    expect(screen.getByLabelText('Mobile number')).toHaveAccessibleDescription(
      "We'll text you a code",
    );
    expect(screen.getByText('+91')).toBeInTheDocument();
  });

  it('toggles password visibility', () => {
    render(<PasswordInput id="pw" aria-label="Password" />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
  });

  it('OTP field supports SMS autofill and a numeric keypad', () => {
    render(<OtpInput aria-label="Code" />);
    const input = screen.getByLabelText('Code');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
  });

  it('announces error alerts', () => {
    render(
      <Alert tone="error" title="Sign-in failed">
        Try again.
      </Alert>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed');
  });
});
