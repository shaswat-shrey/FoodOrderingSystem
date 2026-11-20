import type { Prisma, PrismaClient } from '@fos/db';
import { uuidv7 } from '@fos/shared';

/** Raises an operations alert; an OPEN alert with the same dedupe key is not duplicated. */
export async function raiseOpsAlert(
  db: PrismaClient | Prisma.TransactionClient,
  alert: {
    type: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    message: string;
    refType?: string;
    refId?: string;
    dedupeKey: string;
  },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO ops_alerts (id, type, severity, ref_type, ref_id, message, status, dedupe_key)
    VALUES (${uuidv7()}::uuid, ${alert.type}, ${alert.severity}::"AlertSeverity", ${alert.refType ?? null}, ${alert.refId ?? null}::uuid,
      ${alert.message.slice(0, 500)}, 'OPEN', ${alert.dedupeKey.slice(0, 160)})
    ON CONFLICT (dedupe_key) WHERE status = 'OPEN' DO NOTHING`;
}
