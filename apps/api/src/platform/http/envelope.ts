import type { Response } from 'express';
import type { ApiFailure, ApiMeta, ApiSuccess } from '@fos/types';

function requestIdOf(res: Response): string | undefined {
  return typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
}

/** Sends the standard success envelope (SRS §14.1). */
export function sendOk<T>(
  res: Response,
  data: T,
  {
    status = 200,
    message = 'OK',
    meta = {},
  }: { status?: number; message?: string; meta?: ApiMeta } = {},
): void {
  const body: ApiSuccess<T> = {
    success: true,
    message,
    data,
    meta: { requestId: requestIdOf(res), ...meta },
  };
  res.status(status).json(body);
}

export function sendError(
  res: Response,
  status: number,
  error: ApiFailure['error'],
  message: string,
): void {
  const body: ApiFailure = {
    success: false,
    message,
    error,
    meta: { requestId: requestIdOf(res) },
  };
  res.status(status).json(body);
}
