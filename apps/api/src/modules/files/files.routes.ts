import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import busboy from 'busboy';
import type { FilePurpose } from '@fos/db';
import { z } from 'zod';
import * as schema from '@fos/validation';
import type { Clock } from '../../platform/clock';
import { sendOk } from '../../platform/http/envelope';
import { AppError } from '../../platform/http/errors';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, type AuthMiddlewareDeps } from '../auth';
import type { FilesService } from './files.service';
import { EXTENSION, MAX_UPLOAD_BYTES, PURPOSES, type DetectedType } from './policy';
import { LocalStorageProvider } from './storage';

export interface FilesRouterDeps extends AuthMiddlewareDeps {
  files: FilesService;
  limiter: RateLimiter;
  clock: Clock;
}

/** Reads one `file` part and the `purpose` field; stops at the size cap (413). */
function readUpload(req: Request): Promise<{ purpose: string | undefined; body: Buffer }> {
  return new Promise((resolve, reject) => {
    if (!req.is('multipart/form-data'))
      return reject(
        new AppError('UNSUPPORTED_MEDIA_TYPE', {
          message: 'Send the file as multipart/form-data.',
        }),
      );
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: 1, fields: 2, fileSize: MAX_UPLOAD_BYTES },
      });
    } catch (error) {
      return reject(
        new AppError('VALIDATION_ERROR', { message: 'Malformed upload.', cause: error }),
      );
    }
    let purpose: string | undefined;
    const chunks: Buffer[] = [];
    let gotFile = false;
    let tooLarge = false;
    bb.on('field', (name, value) => {
      if (name === 'purpose') purpose = value;
    });
    bb.on('file', (name, stream) => {
      if (name !== 'file' || gotFile) return stream.resume();
      gotFile = true;
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => {
        tooLarge = true;
      });
    });
    bb.on('error', (error) =>
      reject(new AppError('VALIDATION_ERROR', { message: 'Malformed upload.', cause: error })),
    );
    bb.on('close', () => {
      if (tooLarge) return reject(new AppError('FILE_TOO_LARGE'));
      if (!gotFile)
        return reject(
          new AppError('VALIDATION_ERROR', { message: 'Attach a file in the "file" field.' }),
        );
      resolve({ purpose, body: Buffer.concat(chunks) });
    });
    req.pipe(bb);
  });
}

const CONTENT_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION).map(([type, ext]) => [ext, type as DetectedType]),
);

/**
 * API-FILE-001: multipart upload. Mounted with the raw-body routes, ahead of
 * the JSON-only guard and JSON parser (routes.ts `mountRawRoutes`).
 */
export function fileUploadRouter(deps: FilesRouterDeps): Router {
  const router = Router();
  const authed: RequestHandler[] = [requireClientApp(), authenticate(deps)];
  const auth = (res: Response) => res.locals.auth!;
  const uploads = rateLimit(deps.limiter, {
    name: 'rl:upload:user',
    limit: 30,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth!.userId,
  });
  router.post(
    '/files',
    ...authed,
    uploads,
    handle({}, async ({ req, res }) => {
      const { purpose, body } = await readUpload(req);
      if (!purpose || !(purpose in PURPOSES))
        throw new AppError('VALIDATION_ERROR', {
          details: [{ path: 'purpose', code: 'INVALID', message: 'Unknown upload purpose.' }],
        });
      const a = auth(res);
      sendOk(
        res,
        await deps.files.upload({ userId: a.userId, app: a.app }, purpose as FilePurpose, body),
        {
          status: 201,
        },
      );
    }),
  );
  return router;
}

/** API-FILE-002/003, plus local-driver media serving (development and tests only). */
export function filesRouter(deps: FilesRouterDeps): Router {
  const router = Router();
  const authed: RequestHandler[] = [requireClientApp(), authenticate(deps)];
  const auth = (res: Response) => res.locals.auth!;

  router.get(
    '/files/:fileId/url',
    ...authed,
    handle({ params: z.object({ fileId: schema.idSchema }).strict() }, async ({ params, res }) => {
      const a = auth(res);
      res.setHeader('Cache-Control', 'private, no-store');
      sendOk(
        res,
        await deps.files.signedUrl(
          { userId: a.userId, app: a.app, sessionId: a.sessionId },
          params.fileId,
        ),
      );
    }),
  );
  router.delete(
    '/files/:fileId',
    ...authed,
    handle({ params: z.object({ fileId: schema.idSchema }).strict() }, async ({ params, res }) => {
      await deps.files.remove(auth(res).userId, params.fileId);
      sendOk(res, null, { message: 'File deleted' });
    }),
  );

  return router;
}

/**
 * Local-driver media (development and tests only): public images and signed
 * private links. Mounted beside the raw routes because browsers load images
 * without the X-Client-App header.
 */
export function localMediaRouter(deps: Pick<FilesRouterDeps, 'files' | 'clock'>): Router {
  const router = Router();
  const storage = deps.files.storage;
  if (storage instanceof LocalStorageProvider) {
    const serve = async (res: Response, bucket: 'public' | 'private', key: string) => {
      const ext = key.split('.').pop() ?? '';
      const type = CONTENT_TYPES[ext];
      if (!type) throw new AppError('NOT_FOUND');
      const body = await storage.get(bucket, key).catch(() => {
        throw new AppError('NOT_FOUND');
      });
      res.status(200).type(type).setHeader('X-Content-Type-Options', 'nosniff');
      // The web apps run on other origins; helmet's default same-origin would block <img>.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (type === 'application/pdf') res.setHeader('Content-Disposition', 'inline');
      res.setHeader(
        'Cache-Control',
        bucket === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store',
      );
      res.send(body);
    };
    router.get(/^\/media\/(.+)$/, (req, res, next) => {
      serve(res, 'public', (req.params as Record<string, string>)[0]!).catch(next);
    });
    router.get(/^\/files\/private\/(.+)$/, (req, res, next) => {
      const key = (req.params as Record<string, string>)[0]!;
      const expires = Number(req.query.expires);
      const sig = String(req.query.sig ?? '');
      if (!storage.verify(key, expires, sig, deps.clock.now()))
        return next(new AppError('FORBIDDEN', { message: 'This link has expired.' }));
      serve(res, 'private', key).catch(next);
    });
  }
  return router;
}
