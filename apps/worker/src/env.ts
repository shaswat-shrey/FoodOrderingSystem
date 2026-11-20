import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
  REDIS_CORE_URL: z.url().refine((v) => v.startsWith('redis'), 'Must be a redis:// URL'),
  DATABASE_URL: z.url().refine((v) => v.startsWith('postgres'), 'Must be a postgres:// URL'),
  /** Same secret as the API (identifier hashing/tombstones). */
  AUTH_HMAC_SECRET: z
    .string()
    .refine((v) => Buffer.byteLength(v) >= 32, 'Must be at least 32 bytes'),
  /** Development delivery for OTPs/emails until real providers exist (Phase 7). */
  DEV_MESSAGE_SINK: z.enum(['log', 'file']).default('file'),
  DEV_MESSAGE_FILE: z.string().default('.local/dev-messages.log'),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment configuration:\n${problems}`);
  }
  return result.data;
}
