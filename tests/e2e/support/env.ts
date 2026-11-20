import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Where the end-to-end stack runs. Everything has its own port, database and
 * Redis database index so the suite never touches the development stack (or
 * other projects on 4000/5173). Override any value through the environment.
 */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const E2E_DIR = fileURLToPath(new URL('../', import.meta.url));

/** The repo's .env, read only to reuse local database/Redis credentials. */
function dotenv(): Record<string, string> {
  const path = `${ROOT}.env`;
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

const local = dotenv();

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

function withRedisDb(url: string, index: number): string {
  const u = new URL(url);
  u.pathname = `/${index}`;
  return u.toString();
}

const PORTS = {
  api: Number(process.env.E2E_API_PORT ?? 4300),
  worker: Number(process.env.E2E_WORKER_PORT ?? 4301),
  customer: Number(process.env.E2E_CUSTOMER_PORT ?? 5373),
  restaurant: Number(process.env.E2E_RESTAURANT_PORT ?? 5374),
  delivery: Number(process.env.E2E_DELIVERY_PORT ?? 5375),
  admin: Number(process.env.E2E_ADMIN_PORT ?? 5376),
};

export const E2E = {
  ports: PORTS,
  apiUrl: `http://127.0.0.1:${PORTS.api}`,
  apps: {
    customer: `http://localhost:${PORTS.customer}`,
    restaurant: `http://localhost:${PORTS.restaurant}`,
    delivery: `http://localhost:${PORTS.delivery}`,
    admin: `http://localhost:${PORTS.admin}`,
  },
  databaseUrl:
    process.env.E2E_DATABASE_URL ??
    withDatabase(
      local.DATABASE_URL ?? 'postgresql://fos:fos_dev_password@localhost:5433/fos',
      'fos_e2e',
    ),
  redisCoreUrl:
    process.env.E2E_REDIS_CORE_URL ??
    withRedisDb(local.REDIS_CORE_URL ?? 'redis://localhost:6390', 13),
  redisCacheUrl:
    process.env.E2E_REDIS_CACHE_URL ??
    withRedisDb(local.REDIS_CACHE_URL ?? 'redis://localhost:6391', 14),
  /** The worker's message sink for this run (OTPs, emailed codes). */
  messageLog: `${ROOT}.local/e2e/dev-messages.log`,
  /** Files written by the API's local storage driver. */
  storageDir: `${ROOT}.local/e2e/storage`,
  /** Per-run values from global setup (the generated staff password). */
  runFile: `${ROOT}.local/e2e/run.json`,
  logDir: `${ROOT}.local/e2e/logs`,
};

/** The suite seeds (truncates) its database, so it refuses anything not named *_e2e. */
export function assertE2eDatabase(url: string): void {
  const name = new URL(url).pathname.slice(1);
  if (!/_e2e$/.test(name))
    throw new Error(`Refusing to use database "${name}": the E2E database name must end in _e2e.`);
}

/** Seeded accounts used by the journeys (packages/db/src/seed/data.ts). */
export const SEED = {
  admin: { phone: '+919000000001', email: 'superadmin@example.com' },
  opsAdmin: { phone: '+919000000002', email: 'admin@example.com' },
  owner: { phone: '+919000000201' },
  manager: { phone: '+919000000301' },
  partners: {
    journey: '9000000401',
    rejecter: '9000000402',
    acceptor: '9000000403',
    a11y: '9000000404',
  },
  restaurant: 'Saffron Handi Biryani',
} as const;

/** Coordinates in the seeded zones (README "Locations during development"). */
export const PLACES = {
  /** Saffron Handi Biryani, Koramangala (blr-south). */
  saffronKoramangala: { lat: 12.935, lng: 77.6241 },
  /** Saffron Handi Biryani, Indiranagar (blr-east). */
  saffronIndiranagar: { lat: 12.9712, lng: 77.6408 },
  /** A customer in Koramangala, about 1 km from the branch. */
  koramangalaHome: { lat: 12.929, lng: 77.629 },
  /** A customer in Indiranagar, about 1 km from the branch. */
  indiranagarHome: { lat: 12.977, lng: 77.646 },
} as const;
