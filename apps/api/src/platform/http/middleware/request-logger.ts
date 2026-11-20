import type { RequestHandler } from 'express';
import type { Logger } from '../../logger';

/**
 * One structured log line per request with route template, status and latency
 * (NFR-OBS-001). Bodies and headers are not logged.
 */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : undefined;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level](
        {
          requestId: res.locals.requestId,
          method: req.method,
          route: route ?? 'unmatched',
          status: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
        },
        'request completed',
      );
    });
    next();
  };
}
