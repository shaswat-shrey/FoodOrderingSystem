import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { REQUEST_ID_HEADER } from '@fos/shared';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Accepts a well-formed client `X-Request-Id` or generates one, exposes it as
 * `res.locals.requestId` and echoes it in the response (NFR-OBS-002).
 * Malformed values are replaced so they can't inject into logs.
 */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
