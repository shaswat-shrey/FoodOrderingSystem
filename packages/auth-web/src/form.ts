import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';
import { z } from 'zod';
import { isApiClientError } from '@fos/api-client';

/** React Hook Form bound to a shared Zod schema (same rules as the API). */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  defaultValues?: z.input<S>,
) {
  return useForm<z.input<S>, unknown, z.output<S>>({
    resolver: zodResolver(schema as never) as never,
    mode: 'onTouched',
    ...(defaultValues ? { defaultValues: defaultValues as never } : {}),
  });
}

/** Ten-digit Indian mobile as typed by the user; sent to the API as +91XXXXXXXXXX. */
export const mobileDigitsSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+?91)(?=\d{10}$)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'));

export const toE164 = (digits: string) => `+91${digits}`;

/**
 * Maps an API failure onto the form: field-level details go next to their
 * inputs, everything else becomes one banner message (ERR-007).
 */
export function useServerError<T extends FieldValues>() {
  const [message, setMessage] = useState<string | null>(null);
  const apply = (
    error: unknown,
    setError?: UseFormSetError<T>,
    fieldMap: Record<string, Path<T>> = {},
  ) => {
    if (isApiClientError(error)) {
      let placed = false;
      for (const detail of error.details) {
        const field = detail.path ? (fieldMap[detail.path] ?? (detail.path as Path<T>)) : undefined;
        if (field && setError) {
          setError(field, { type: 'server', message: detail.message });
          placed = true;
        }
      }
      setMessage(placed ? null : error.message);
      return;
    }
    setMessage('Something went wrong. Please try again.');
  };
  return { message, setMessage, apply };
}

export function errorCode(error: unknown): string | undefined {
  return isApiClientError(error) ? error.code : undefined;
}
