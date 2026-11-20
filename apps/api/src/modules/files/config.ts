import { z } from 'zod';

/** Storage environment (FR-FILE-005, IF-STO-001). Shared by the API and the worker. */
export const storageEnvFields = {
  /** `local` = files under STORAGE_LOCAL_DIR served by the API (dev/test); `s3` = S3-compatible. */
  STORAGE_DRIVER: z.enum(['local', 's3']).optional(),
  STORAGE_LOCAL_DIR: z.string().default('.local/storage'),
  STORAGE_ENDPOINT: z.url().optional(),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_ACCESS_KEY: z.string().min(1).optional(),
  STORAGE_SECRET_KEY: z.string().min(1).optional(),
  STORAGE_PUBLIC_BUCKET: z.string().min(3).default('fos-public-media'),
  STORAGE_PRIVATE_BUCKET: z.string().min(3).default('fos-private-docs'),
  /** CDN or bucket URL for public media; defaults to the API's own file route. */
  PUBLIC_MEDIA_BASE_URL: z.url().optional(),
  /** How browsers reach this API (signed URLs, local media). */
  API_PUBLIC_URL: z.url().optional(),
};

export type StorageEnv = { NODE_ENV: string; API_PORT?: number } & z.output<
  z.ZodObject<typeof storageEnvFields>
>;

export const storageDriverOf = (env: StorageEnv) =>
  env.STORAGE_DRIVER ?? (env.NODE_ENV === 'production' ? 's3' : 'local');

export const apiPublicUrlOf = (env: StorageEnv) =>
  (env.API_PUBLIC_URL ?? `http://localhost:${env.API_PORT ?? 4000}`).replace(/\/$/, '');

export function storageEnvProblems(env: StorageEnv): [string, string][] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: [string, string][] = [];
  if (storageDriverOf(env) !== 's3')
    problems.push(['STORAGE_DRIVER', 'Production stores files in S3-compatible storage']);
  for (const key of ['STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY', 'API_PUBLIC_URL'] as const)
    if (!env[key]) problems.push([key, 'Required in production']);
  if (env.API_PUBLIC_URL && !env.API_PUBLIC_URL.startsWith('https://'))
    problems.push(['API_PUBLIC_URL', 'Must be https in production']);
  return problems;
}
