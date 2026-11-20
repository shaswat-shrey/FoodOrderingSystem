import { forwardRef, useState } from 'react';
import { Input, type InputProps } from './Input';

/** Password field with a show/hide toggle (UI-AUTH: no copy-paste blocking). */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'prefix'>>(
  ({ className, ...props }, ref) => {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={`pr-16 ${className ?? ''}`}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-controls={props.id}
          className="absolute inset-y-0 right-0 flex min-w-11 items-center px-3 text-sm font-medium text-brand-700"
        >
          {visible ? 'Hide' : 'Show'}
          <span className="sr-only"> password</span>
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = 'PasswordInput';
