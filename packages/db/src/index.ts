import { PrismaClient } from '@prisma/client';

// Re-export the generated client: PrismaClient, the Prisma namespace and every enum type.
export * from '@prisma/client';

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

/** Development/test dataset loader (never run against production). */
export { resetDatabase, seedDatabase, type SeedSummary } from './seed/seed';
