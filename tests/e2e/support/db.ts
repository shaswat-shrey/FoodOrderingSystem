import { spawnSync } from 'node:child_process';
import { E2E, E2E_DIR } from './env';

/**
 * Stands in for the passing of time the suite can't wait for: moves an order's
 * no-partner deadline (BR-DEL-003, 30–45 min) to now in the E2E database. The
 * cancellation itself is still done by the worker's dispatch retry and sweep.
 */
export function expireNoPartnerDeadline(orderId: string): void {
  const result = spawnSync(
    `${E2E_DIR}node_modules/.bin/tsx`,
    [`${E2E_DIR}support/db-tool.ts`, 'expire-no-partner-deadline', orderId],
    { env: { ...process.env, DATABASE_URL: E2E.databaseUrl }, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`db-tool failed: ${result.stderr || result.stdout}`);
}
