import { Router } from 'express';
import type { Logger } from '../logger';
import { evaluateReadiness, type ReadinessChecks } from './readiness';

/**
 * API-SYS-001/002. Health endpoints deliberately do not use the response
 * envelope: orchestrators and load balancers read them directly.
 */
export function healthRouter(checks: ReadinessChecks, logger: Logger): Router {
  const router = Router();
  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  router.get('/health/ready', async (_req, res) => {
    const report = await evaluateReadiness(checks, (name, error) =>
      logger.warn({ err: error, dependency: name }, 'readiness check failed'),
    );
    res.status(report.status === 'unavailable' ? 503 : 200).json(report);
  });
  return router;
}
