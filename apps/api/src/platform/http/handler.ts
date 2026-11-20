import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';

type Schema = z.ZodType;
type Infer<S> = S extends z.ZodType ? z.infer<S> : undefined;

export interface HandlerContext<B, Q, P> {
  body: B;
  query: Q;
  params: P;
  req: Request;
  res: Response;
}

/**
 * Wraps a route: validates body, query and params with strict Zod schemas
 * before any business logic runs (DC-03, NFR-SEC-004). Validation failures
 * become 400 VALIDATION_ERROR via the error handler; rejected promises reach
 * Express 5's error handling automatically.
 */
export function handle<
  BS extends Schema | undefined = undefined,
  QS extends Schema | undefined = undefined,
  PS extends Schema | undefined = undefined,
>(
  schemas: { body?: BS; query?: QS; params?: PS },
  fn: (ctx: HandlerContext<Infer<BS>, Infer<QS>, Infer<PS>>) => Promise<void> | void,
): RequestHandler {
  return async (req, res) => {
    const body = schemas.body ? schemas.body.parse(req.body ?? {}) : undefined;
    const query = schemas.query ? schemas.query.parse(req.query) : undefined;
    const params = schemas.params ? schemas.params.parse(req.params) : undefined;
    await fn({ body, query, params, req, res } as HandlerContext<Infer<BS>, Infer<QS>, Infer<PS>>);
  };
}
