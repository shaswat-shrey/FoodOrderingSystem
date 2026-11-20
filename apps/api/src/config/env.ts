import { z } from 'zod';
import type { ClientApp } from '@fos/shared';
import { storageEnvFields, storageEnvProblems } from '../modules/files/config';
import { parseFieldKeys } from '../platform/crypto';
import { paymentEnvFields, paymentEnvProblems } from '../modules/payments/config';

/**
 * Environment configuration (NFR-SEC-011). Parsed once at boot; the process
 * refuses to start when a value is missing or malformed so misconfiguration
 * fails loudly instead of at the first request. Error messages name variables,
 * never values (they may be secrets).
 */

/** `kid:secret` pairs, comma-separated; the first key signs, all keys verify (ADR-003). */
const signingKeys = z.string().transform((value, ctx) => {
  const keys = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':');
      return separator > 0
        ? { kid: entry.slice(0, separator), secret: entry.slice(separator + 1) }
        : null;
    });
  if (keys.length === 0 || keys.some((k) => k === null)) {
    ctx.addIssue({ code: 'custom', message: 'Expected comma-separated "kid:secret" entries' });
    return z.NEVER;
  }
  const valid = keys as { kid: string; secret: string }[];
  if (valid.some((k) => Buffer.byteLength(k.secret) < 32)) {
    ctx.addIssue({ code: 'custom', message: 'Each signing secret must be at least 32 bytes' });
    return z.NEVER;
  }
  if (new Set(valid.map((k) => k.kid)).size !== valid.length) {
    ctx.addIssue({ code: 'custom', message: 'Key ids must be unique' });
    return z.NEVER;
  }
  return valid;
});

const booleanFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    DATABASE_URL: z.url().refine((v) => v.startsWith('postgres'), 'Must be a postgres:// URL'),
    REDIS_CORE_URL: z.url().refine((v) => v.startsWith('redis'), 'Must be a redis:// URL'),
    REDIS_CACHE_URL: z.url().refine((v) => v.startsWith('redis'), 'Must be a redis:// URL'),

    // Public URLs of the four web apps: used for the CORS allowlist, the
    // per-app Origin check on cookie endpoints, and links in emails.
    APP_URL_CUSTOMER: z.url().default('http://localhost:5173'),
    APP_URL_RESTAURANT: z.url().default('http://localhost:5174'),
    APP_URL_DELIVERY: z.url().default('http://localhost:5175'),
    APP_URL_ADMIN: z.url().default('http://localhost:5176'),

    JWT_SIGNING_KEYS: signingKeys,
    JWT_ISSUER: z.string().min(1).default('fos-api'),
    /** HMAC key for OTP codes and identifier hashes (FR-AUTH-010). ≥ 32 bytes. */
    AUTH_HMAC_SECRET: z
      .string()
      .refine((v) => Buffer.byteLength(v) >= 32, 'Must be at least 32 bytes'),
    /** Secure cookies; only `false` for plain-http localhost development. */
    COOKIE_SECURE: booleanFlag.optional(),
    /** Development message sink when no SMS/email provider is configured. */
    DEV_MESSAGE_SINK: z.enum(['log', 'file']).default('file'),
    /**
     * Geocoding provider (IF-GEO-001). `mock` = pilot-city gazetteer for development;
     * `none` = no provider, so address search reports GEO_PROVIDER_UNAVAILABLE and
     * customers drop a map pin (FR-LOC-003 degraded path). A real provider follows OD-13.
     */
    GEO_PROVIDER: z.enum(['mock', 'none']).optional(),
    /** "1:<base64 32 bytes>,2:<…>" — newest last. Derived from AUTH_HMAC_SECRET outside production. */
    FIELD_ENCRYPTION_KEYS: z
      .string()
      .refine((v) => {
        try {
          const keys = parseFieldKeys(v);
          return keys.every((k) => k.key.length === 32 && k.id >= 1 && k.id <= 255);
        } catch {
          return false;
        }
      }, 'Each key must be <id 1–255>:<base64 of 32 bytes>')
      .optional(),
    ...paymentEnvFields,
    ...storageEnvFields,
  })
  .transform((env) => ({
    ...env,
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    GEO_PROVIDER: env.GEO_PROVIDER ?? (env.NODE_ENV === 'production' ? 'none' : 'mock'),
    APP_URLS: {
      CUSTOMER: env.APP_URL_CUSTOMER,
      RESTAURANT: env.APP_URL_RESTAURANT,
      DELIVERY: env.APP_URL_DELIVERY,
      ADMIN: env.APP_URL_ADMIN,
    } satisfies Record<ClientApp, string>,
  }))
  .superRefine((env, ctx) => {
    for (const [path, message] of [...paymentEnvProblems(env), ...storageEnvProblems(env)])
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.NODE_ENV !== 'production') return;
    if (env.GEO_PROVIDER === 'mock') {
      ctx.addIssue({
        code: 'custom',
        path: ['GEO_PROVIDER'],
        message:
          'The mock geocoder returns fictional data; use "none" until a provider is configured (OD-13)',
      });
    }
    if (!env.FIELD_ENCRYPTION_KEYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIELD_ENCRYPTION_KEYS'],
        message: 'Required in production (PAN and bank details are encrypted with it)',
      });
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'Must be true in production',
      });
    }
    for (const [app, url] of Object.entries(env.APP_URLS)) {
      if (!url.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: [`APP_URL_${app}`],
          message: 'Must be https in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new EnvValidationError(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

/** Browser origin (scheme://host:port) of each app, for CORS and Origin checks. */
export function appOrigins(env: Pick<Env, 'APP_URLS'>): Record<ClientApp, string> {
  return Object.fromEntries(
    Object.entries(env.APP_URLS).map(([app, url]) => [app, new URL(url).origin]),
  ) as Record<ClientApp, string>;
}
