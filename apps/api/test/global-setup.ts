import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient, seedDatabase } from '@fos/db';

/** The API suite uses its own database (`<TEST_DATABASE_URL db>_api`) so it can run alongside @fos/db tests. */
export function apiTestDatabaseUrl(): string | undefined {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return undefined;
  const url = new URL(base);
  url.pathname = `${url.pathname}_api`;
  return url.toString();
}

export default async function setup(): Promise<void> {
  const url = apiTestDatabaseUrl();
  if (!url || !process.env.TEST_REDIS_URL) {
    process.stderr.write(
      '\n⚠ TEST_DATABASE_URL / TEST_REDIS_URL not set — API integration tests will be skipped.\n\n',
    );
    return;
  }
  const name = new URL(url).pathname.slice(1);
  if (!/_test/.test(name))
    throw new Error('API test database name must contain "_test" (it is wiped).');

  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const admin = new PrismaClient({ datasourceUrl: maintenance.toString() });
  const exists = await admin.$queryRaw<
    unknown[]
  >`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (exists.length === 0) {
    // CREATE DATABASE cannot take bind parameters; the name was validated above.
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Unsafe test database name');
    await admin.$executeRaw(Prisma.raw(`CREATE DATABASE "${name}"`));
  }
  await admin.$disconnect();

  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$executeRaw`DROP SCHEMA IF EXISTS public CASCADE`;
  await prisma.$executeRaw`CREATE SCHEMA public`;
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema'], {
    cwd: fileURLToPath(new URL('../../../packages/db', import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  await seedDatabase(prisma);
  await prisma.$disconnect();
}
