import type { RequestHandler } from 'express';
import { CLIENT_APP_HEADER, CLIENT_APPS, type ClientApp } from '@fos/shared';
import { AppError } from '../errors';

function isClientApp(value: unknown): value is ClientApp {
  return typeof value === 'string' && (CLIENT_APPS as readonly string[]).includes(value);
}

/** Requires a valid `X-Client-App` header and exposes it as `res.locals.clientApp`. */
export function requireClientApp(): RequestHandler {
  return (req, res, next) => {
    const app = req.header(CLIENT_APP_HEADER);
    if (!isClientApp(app)) {
      next(
        new AppError('VALIDATION_ERROR', { message: 'Missing or invalid X-Client-App header.' }),
      );
      return;
    }
    res.locals.clientApp = app;
    next();
  };
}

/**
 * CSRF defence for cookie-authenticated endpoints (BR-AUTH-019, NFR-SEC-007):
 * the browser Origin must be exactly the origin of the app named in X-Client-App.
 * Use after requireClientApp().
 */
export function requireTrustedOrigin(origins: Record<ClientApp, string>): RequestHandler {
  return (req, res, next) => {
    const app = res.locals.clientApp;
    if (!app || req.header('origin') !== origins[app]) {
      next(
        new AppError('CSRF_ORIGIN_MISMATCH', {
          message: 'This request was not sent from a trusted app.',
        }),
      );
      return;
    }
    next();
  };
}
