import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

/**
 * Rebuilds the test database from the committed migrations, so the tests exercise
 * exactly the SQL that production runs. Skipped when TEST_DATABASE_URL is unset.
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    process.stderr.write(
      '\n⚠ TEST_DATABASE_URL not set — database integration tests will be skipped.\n\n',
    );
    return;
  }
  if (!/fos_test|_test\b/.test(url)) {
    throw new Error('TEST_DATABASE_URL must point at a dedicated *_test database (it is wiped).');
  }
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$executeRaw`DROP SCHEMA IF EXISTS public CASCADE`;
  await prisma.$executeRaw`CREATE SCHEMA public`;
  await prisma.$disconnect();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
