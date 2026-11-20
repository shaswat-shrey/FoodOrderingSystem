import { createServer, type Server } from 'node:http';
import { evaluateReadiness, type Logger, type ReadinessChecks } from '@fos/api/platform';

/** Liveness/readiness for the orchestrator (NFR-AVAIL-006). The worker needs Redis to do anything. */
export function createHealthServer(checks: ReadinessChecks, logger?: Logger): Server {
  return createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/health/live') {
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/health/ready') {
      const report = await evaluateReadiness(checks, (name, error) =>
        logger?.warn({ err: error, dependency: name }, 'readiness check failed'),
      );
      res.statusCode = report.status === 'unavailable' ? 503 : 200;
      res.end(JSON.stringify(report));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ status: 'not_found' }));
  });
}
