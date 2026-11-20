import { PrismaClient } from '@prisma/client';

export { PrismaClient };
export { Prisma } from '@prisma/client';

export interface CreatePrismaClientOptions {
  url: string;
  /** Log slow/err queries through the caller's logger instead of stdout. */
  onQueryError?: (message: string) => void;
}

/**
 * Creates a Prisma client for one process. API and worker each create exactly
 * one client at boot and disconnect it on shutdown (NFR-REL-007).
 */
export function createPrismaClient({ url, onQueryError }: CreatePrismaClientOptions): PrismaClient {
  const client = new PrismaClient({
    datasourceUrl: url,
    log: [{ emit: 'event', level: 'error' }],
  });
  if (onQueryError) {
    client.$on('error', (event) => onQueryError(event.message));
  }
  return client;
}

/** Lightweight connectivity probe used by readiness checks (API-SYS-002). */
export async function pingDatabase(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}
