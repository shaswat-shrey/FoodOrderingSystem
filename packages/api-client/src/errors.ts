import type { ApiErrorDetail } from '@fos/types';

/**
 * Normalised error for every failed API call (SRS §19, ERR-007). UI code reads
 * `code` (stable) and `message` (safe to display), never raw Axios errors.
 */
export class ApiClientError extends Error {
  override readonly name = 'ApiClientError';

  constructor(
    readonly code: string,
    message: string,
    readonly status: number | undefined,
    readonly details: ApiErrorDetail[] = [],
    readonly retryable = false,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}
