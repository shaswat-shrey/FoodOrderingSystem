import type { ErrorCode } from '@fos/shared';

/** Field-level or item-level error detail (SRS §14.1). */
export interface ApiErrorDetail {
  path?: string;
  code: string;
  message: string;
}

export interface ApiMeta {
  requestId?: string;
  pagination?: {
    nextCursor?: string | null;
    hasMore?: boolean;
    page?: number;
    pageSize?: number;
    total?: number;
  };
}

export interface ApiSuccess<T> {
  success: true;
  message: string;
  data: T;
  meta: ApiMeta;
}

export interface ApiFailure {
  success: false;
  message: string;
  error: {
    code: ErrorCode | (string & {});
    details: ApiErrorDetail[];
    retryable: boolean;
  };
  meta: ApiMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Response of GET /health/ready (API-SYS-002). */
export interface ReadinessReport {
  status: 'ok' | 'degraded' | 'unavailable';
  checks: Record<string, { status: 'up' | 'down'; latencyMs?: number; error?: string }>;
}
