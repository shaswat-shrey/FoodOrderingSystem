/**
 * E2E database preparation, run by global setup through tsx (it needs the
 * Prisma client and the API's password hashing, which Playwright's loader
 * doesn't handle):
 *
 *   tsx prepare-db.ts create   create the database and extensions if missing
 *   tsx prepare-db.ts seed     load the development seed, then E2E-only data setup
 *
 * Only ever runs against a database whose name ends in _e2e.
 */
import { createPrismaClient, Prisma, seedDatabase } from '@fos/db';
import { hashPassword } from '../../../apps/api/src/modules/auth/password';
import { assertE2eDatabase } from './env';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
assertE2eDatabase(url);

async function create(): Promise<void> {
  const name = new URL(url!).pathname.slice(1);
  const maintenance = new URL(url!);
  maintenance.pathname = '/postgres';
  const admin = createPrismaClient({ url: maintenance.toString() });
  try {
    const rows = await admin.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM pg_database WHERE datname = ${name}`;
    // The name is checked above (…_e2e); CREATE DATABASE takes no bind parameters.
    if (rows.length === 0) await admin.$executeRaw(Prisma.raw(`CREATE DATABASE "${name}"`));
  } finally {
    await admin.$disconnect();
  }
  const db = createPrismaClient({ url: url! });
  try {
    // Fixed names, not input; DDL takes no bind parameters.
    for (const ext of ['postgis', 'pg_trgm', 'unaccent', 'citext', 'pgcrypto'])
      await db.$executeRaw(Prisma.raw(`CREATE EXTENSION IF NOT EXISTS ${ext}`));
  } finally {
    await db.$disconnect();
  }
}

/** HH:MM in India time, `minutesAgo` before now. */
function istClock(minutesAgo: number): string {
  const t = new Date(Date.now() - minutesAgo * 60_000);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(t);
}

async function seed(): Promise<void> {
  const prisma = createPrismaClient({ url: url! });
  try {
    await seedDatabase(prisma);

    // Seeded restaurants keep real hours, which would fail the suite at night. Each
    // branch gets one slot a day of 23 h 59 min that starts an hour before now, so it
    // is open (and well clear of the last-order cutoff) for the next ~22 hours.
    const start = istClock(60);
    const end = istClock(61);
    await prisma.$executeRaw`DELETE FROM branch_operating_hours`;
    await prisma.$executeRaw`DELETE FROM branch_holidays`;
    await prisma.$executeRaw`
      INSERT INTO branch_operating_hours (id, branch_id, weekday, opens_at, closes_at)
      SELECT gen_random_uuid(), b.id, d, ${start}::time, ${end}::time
      FROM branches b CROSS JOIN generate_series(0, 6) AS d`;
    await prisma.$executeRaw`UPDATE branches SET is_open_manual = true, paused_until = NULL`;

    // AC-E2E-007 cancels after the free window; 15 s instead of 60 s keeps the run short.
    await prisma.platformSetting.upsert({
      where: { key: 'cancellation.freeWindowAfterAcceptSeconds' },
      create: { key: 'cancellation.freeWindowAfterAcceptSeconds', value: 15 },
      update: { value: 15 },
    });

    // Restaurant staff and the admin sign in with a password generated for this run.
    const password = process.env.E2E_STAFF_PASSWORD;
    if (!password) throw new Error('E2E_STAFF_PASSWORD is not set');
    const passwordHash = await hashPassword(password);
    const staff = await prisma.user.findMany({
      where: {
        phone: { in: ['+919000000001', '+919000000002', '+919000000201', '+919000000301'] },
      },
      select: { id: true },
    });
    for (const { id } of staff)
      await prisma.userCredential.upsert({
        where: { userId: id },
        create: { userId: id, passwordHash },
        update: { passwordHash },
      });
  } finally {
    await prisma.$disconnect();
  }
}

const phase = process.argv[2];
(phase === 'create' ? create() : phase === 'seed' ? seed() : Promise.reject(new Error(phase)))
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exit(1);
  });
