/**
 * Test-side data changes the UI can't make, run through tsx (see db.ts):
 *
 *   tsx db-tool.ts expire-no-partner-deadline <orderId>
 *
 * Only ever runs against a database whose name ends in _e2e.
 */
import { createPrismaClient } from '@fos/db';
import { assertE2eDatabase } from './env';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
assertE2eDatabase(url);

async function main(command: string | undefined, orderId: string | undefined): Promise<void> {
  if (command !== 'expire-no-partner-deadline' || !orderId)
    throw new Error('usage: db-tool.ts expire-no-partner-deadline <orderId>');
  const prisma = createPrismaClient({ url: url! });
  try {
    // BR-DEL-003's deadline is 30–45 min away; move it to now so the worker's own
    // dispatch retry / sweep (every minute) reaches it, as if the time had passed.
    const changed = await prisma.$executeRaw`
      UPDATE deliveries SET no_partner_deadline = now() - interval '1 second'
      WHERE order_id = ${orderId}::uuid AND status IN ('PENDING', 'SEARCHING')`;
    if (changed !== 1) throw new Error(`no searching delivery for order ${orderId}`);
  } finally {
    await prisma.$disconnect();
  }
}

main(process.argv[2], process.argv[3])
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
