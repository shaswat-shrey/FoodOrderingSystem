import { DEFAULT_ERROR_MESSAGES, httpStatusFor, type ErrorCode } from '@fos/shared';
import type { ApiErrorDetail } from '@fos/types';

export interface AppErrorOptions {
  message?: string;
  details?: ApiErrorDetail[];
  retryable?: boolean;
  /** Overrides the default HTTP status for the code (rarely needed). */
  status?: number;
  cause?: unknown;
}

/**
 * The only error type domain code should throw for expected failures (ERR-002).
 * `message` must be safe to show to end users.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ApiErrorDetail[];
  readonly retryable: boolean;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? DEFAULT_ERROR_MESSAGES[code] ?? code, { cause: options.cause });
    this.code = code;
    this.status = options.status ?? httpStatusFor(code);
    this.details = options.details ?? [];
    this.retryable = options.retryable ?? this.status >= 500;
  }
}
