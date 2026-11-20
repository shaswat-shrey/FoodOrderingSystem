import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { API_PREFIX } from '@fos/shared';
import { healthRouter } from '../health/health.routes';
import type { ReadinessChecks } from '../health/readiness';
import type { Logger } from '../logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestId } from './middleware/request-id';
import { requestLogger } from './middleware/request-logger';
import { requireJsonBody } from './middleware/require-json';

export interface AppDependencies {
  logger: Logger;
  corsOrigins: string[];
  readiness: ReadinessChecks;
}

/**
 * Builds the Express application. Pure factory (no listening, no global state)
 * so tests can run it in-process with fake dependencies.
 */
export function createApp({ logger, corsOrigins, readiness }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Nginx / load balancer (SYSTEM-ARCHITECTURE §2)

  app.use(requestId());
  app.use(requestLogger(logger));
  app.use(helmet()); // NFR-SEC-008
  app.use(
    cors({
      origin: corsOrigins, // NFR-SEC-009: explicit allowlist
      credentials: false, // only /auth routes will allow credentials (Phase 4)
      exposedHeaders: ['x-request-id', 'idempotent-replayed', 'retry-after'],
    }),
  );

  app.use(healthRouter(readiness, logger));

  // Routes with non-JSON bodies (payment webhooks, uploads) mount here, before JSON parsing.

  app.use(requireJsonBody());
  app.use(express.json({ limit: '100kb', strict: true })); // NFR-SEC-004

  const api = express.Router();
  // Module routers are mounted on `api` as modules are implemented (Phase 4+).
  app.use(API_PREFIX, api);

  app.use(notFoundHandler());
  app.use(errorHandler(logger));
  return app;
}
