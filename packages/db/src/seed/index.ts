/**
 * Development seed CLI:  pnpm --filter @fos/db db:seed
 * Truncates every table and loads the pilot-city dataset. Refuses to run in production.
 */
import { createPrismaClient } from '../index';
import { seedDatabase } from './seed';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production (the seed truncates all tables).');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const prisma = createPrismaClient({ url });
  try {
    const started = Date.now();
    const summary = await seedDatabase(prisma);
    process.stdout.write(`Seeded in ${Date.now() - started} ms: ${JSON.stringify(summary)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
