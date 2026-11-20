import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { assertE2eDatabase, E2E, E2E_DIR, ROOT } from './env';
import { flushRedisDb } from './redis';

/**
 * Brings up the whole stack for the suite on its own ports (API, worker and the
 * four built apps behind `vite preview`), against a freshly migrated and seeded
 * `*_e2e` database and dedicated Redis database indexes. Returns the teardown.
 *
 *   E2E_SKIP_BUILD=1   reuse the apps' existing dist/ (CI builds them first)
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  assertE2eDatabase(E2E.databaseUrl);
  rmSync(`${ROOT}.local/e2e`, { recursive: true, force: true });
  mkdirSync(E2E.logDir, { recursive: true });
  mkdirSync(E2E.storageDir, { recursive: true });

  // Generated per run (never a real secret); the specs read it from run.json.
  const staffPassword = `e2e ${randomBytes(12).toString('base64url')} staff`;
  writeFileSync(E2E.runFile, JSON.stringify({ staffPassword }));

  const dbEnv = {
    ...process.env,
    DATABASE_URL: E2E.databaseUrl,
    NODE_ENV: 'test',
    E2E_STAFF_PASSWORD: staffPassword,
  };
  const prepare = `${E2E_DIR}support/prepare-db.ts`;
  step('create database', 'pnpm', ['--filter', '@fos/db', 'exec', 'tsx', prepare, 'create'], dbEnv);
  step('migrate database', 'pnpm', ['--filter', '@fos/db', 'db:deploy'], dbEnv);
  step('seed database', 'pnpm', ['--filter', '@fos/db', 'exec', 'tsx', prepare, 'seed'], dbEnv);
  await flushRedisDb(E2E.redisCoreUrl);
  await flushRedisDb(E2E.redisCacheUrl);

  const apps = ['customer', 'restaurant', 'delivery', 'admin'] as const;
  if (!process.env.E2E_SKIP_BUILD)
    step(
      'build apps',
      'pnpm',
      apps.flatMap((a) => ['--filter', `@fos/${a}-web`]).concat('build'),
      process.env,
    );

  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'info',
    DATABASE_URL: E2E.databaseUrl,
    REDIS_CORE_URL: E2E.redisCoreUrl,
    REDIS_CACHE_URL: E2E.redisCacheUrl,
    API_PORT: String(E2E.ports.api),
    WORKER_HEALTH_PORT: String(E2E.ports.worker),
    APP_URL_CUSTOMER: E2E.apps.customer,
    APP_URL_RESTAURANT: E2E.apps.restaurant,
    APP_URL_DELIVERY: E2E.apps.delivery,
    APP_URL_ADMIN: E2E.apps.admin,
    // Development-only values generated for this run.
    JWT_SIGNING_KEYS: `e2e:${randomBytes(32).toString('hex')}`,
    AUTH_HMAC_SECRET: randomBytes(32).toString('hex'),
    COOKIE_SECURE: 'false',
    DEV_MESSAGE_SINK: 'file',
    DEV_MESSAGE_FILE: E2E.messageLog,
    GEO_PROVIDER: 'mock',
    PAYMENT_PROVIDER: 'mock',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: E2E.storageDir,
  };
  delete serverEnv.FIELD_ENCRYPTION_KEYS;

  const children: ChildProcess[] = [];
  const stop = async () => {
    for (const child of children) kill(child, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    for (const child of children) kill(child, 'SIGKILL');
  };
  try {
    children.push(start('api', `${ROOT}apps/api`, 'tsx', ['src/server.ts'], serverEnv));
    children.push(start('worker', `${ROOT}apps/worker`, 'tsx', ['src/main.ts'], serverEnv));
    for (const app of apps)
      children.push(
        start(
          app,
          `${ROOT}apps/${app}-web`,
          'vite',
          ['preview', '--port', String(E2E.ports[app]), '--strictPort'],
          { ...process.env, VITE_API_PROXY_TARGET: E2E.apiUrl },
        ),
      );
    await waitFor(`${E2E.apiUrl}/health/ready`, 'API');
    await waitFor(`http://127.0.0.1:${E2E.ports.worker}/health/ready`, 'worker');
    for (const app of apps) await waitFor(`${E2E.apps[app]}/`, `${app} app`);
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}

function step(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(cmd, args, { cwd: ROOT, env, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`E2E setup failed to ${name}:\n${result.stdout}\n${result.stderr}`);
}

/** Starts a long-running process in its own group, logging to .local/e2e/logs. */
function start(
  name: string,
  cwd: string,
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const log = openSync(`${E2E.logDir}/${name}.log`, 'a');
  return spawn(`${cwd}/node_modules/.bin/${bin}`, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', log, log],
  });
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

async function waitFor(url: string, what: string, timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not become ready at ${url} (${last}); see ${E2E.logDir}`);
}
