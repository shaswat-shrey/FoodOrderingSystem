import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
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
  /** Mounts module routers on the /api/v1 router. */
  routes?: (api: Router) => void;
  /** Routes that need the raw body (provider webhooks), mounted before JSON parsing. */
  rawRoutes?: (app: Express) => void;
}

/**
 * Builds the Express application. Pure factory (no listening, no global state)
 * so tests can run it in-process with fake dependencies.
 */
export function createApp({
  logger,
  corsOrigins,
  readiness,
  routes,
  rawRoutes,
}: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Nginx / load balancer (SYSTEM-ARCHITECTURE §2)

  app.use(requestId());
  app.use(requestLogger(logger));
  app.use(helmet()); // NFR-SEC-008
  app.use(
    cors({
      origin: corsOrigins, // NFR-SEC-009: explicit allowlist
      // Credentials (the refresh cookie) only matter for /auth; other routes use bearer tokens.
      credentials: true,
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'X-Client-App',
        'X-Request-Id',
        'Idempotency-Key',
        'If-Match',
      ],
      exposedHeaders: ['x-request-id', 'idempotent-replayed', 'retry-after'],
    }),
  );

  app.use(healthRouter(readiness, logger));

  // Routes with non-JSON bodies (payment webhooks, uploads) mount here, before JSON parsing.
  rawRoutes?.(app);

  app.use(requireJsonBody());
  app.use(express.json({ limit: '100kb', strict: true })); // NFR-SEC-004
  app.use(cookieParser());

  const api = express.Router();
  routes?.(api);
  app.use(API_PREFIX, api);

  app.use(notFoundHandler());
  app.use(errorHandler(logger));
  return app;
}
