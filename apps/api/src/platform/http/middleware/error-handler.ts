import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { DEFAULT_ERROR_MESSAGES } from '@fos/shared';
import type { Logger } from '../../logger';
import { sendError } from '../envelope';
import { AppError } from '../errors';
import { RedisUnavailableError } from '../../redis';

/** 404 for unmatched routes, in the standard envelope. */
export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => next(new AppError('NOT_FOUND'));
}

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

function toAppError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  // NFR-AVAIL-004: a Redis-only feature during an outage is "try again", not a crash.
  if (error instanceof RedisUnavailableError)
    return new AppError('SERVICE_UNAVAILABLE', { retryable: true });
  if (error instanceof ZodError) {
    return new AppError('VALIDATION_ERROR', {
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  const parserError = error as BodyParserError;
  if (parserError?.type === 'entity.too.large') {
    return new AppError('PAYLOAD_TOO_LARGE', { message: 'Request body is too large.' });
  }
  if (parserError?.type === 'entity.parse.failed') {
    return new AppError('VALIDATION_ERROR', { message: 'Request body is not valid JSON.' });
  }
  return undefined;
}

/**
 * Single error boundary for HTTP (ERR-002/004/005). Known errors map to their
 * code; anything else becomes a generic 500 and is logged with its stack — the
 * response never contains internals.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    const appError = toAppError(error);
    if (appError) {
      if (appError.status >= 500) {
        logger.error({ err: error, requestId: res.locals.requestId }, 'request failed');
      }
      sendError(
        res,
        appError.status,
        { code: appError.code, details: appError.details, retryable: appError.retryable },
        appError.message,
      );
      return;
    }
    logger.error({ err: error, requestId: res.locals.requestId }, 'unhandled error');
    sendError(
      res,
      500,
      { code: 'INTERNAL_ERROR', details: [], retryable: true },
      DEFAULT_ERROR_MESSAGES.INTERNAL_ERROR ?? 'Internal error',
    );
  };
}
