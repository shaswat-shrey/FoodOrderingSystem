import { z } from 'zod';

/**
 * Environment configuration (NFR-SEC-011). Parsed once at boot; the process
 * refuses to start when a value is missing or malformed so misconfiguration
 * fails loudly instead of at the first request.
 */
const commaSeparatedUrls = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).min(1));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  CORS_ORIGINS: commaSeparatedUrls,
  DATABASE_URL: z.url().refine((v) => v.startsWith('postgres'), 'Must be a postgres:// URL'),
  REDIS_CORE_URL: z.url().refine((v) => v.startsWith('redis'), 'Must be a redis:// URL'),
  REDIS_CACHE_URL: z.url().refine((v) => v.startsWith('redis'), 'Must be a redis:// URL'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Only variable names and messages are reported — never values (they may be secrets).
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new EnvValidationError(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
