import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env';
import { createHealthServer } from './health-server';
import { registrations } from './processors';

let close: (() => void) | undefined;
afterEach(() => close?.());

async function serve(redisUp: boolean) {
  const server = createHealthServer({
    critical: {
      redisCore: async () => {
        if (!redisUp) throw new Error('ECONNREFUSED');
      },
    },
    degradable: {},
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  close = () => server.close();
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

describe('worker', () => {
  it('validates its environment', () => {
    expect(loadWorkerEnv({ REDIS_CORE_URL: 'redis://localhost:6379' }).WORKER_HEALTH_PORT).toBe(4001);
    expect(() => loadWorkerEnv({})).toThrow(/REDIS_CORE_URL/);
  });

  it('reports ready only when Redis is reachable', async () => {
    const ok = await fetch(`${await serve(true)}/health/ready`);
    expect(ok.status).toBe(200);
    close?.();
    const down = await fetch(`${await serve(false)}/health/ready`);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ status: 'unavailable', checks: { redisCore: { error: 'unreachable' } } });
  });

  it('has no processors registered before feature modules exist', () => {
    expect(registrations).toEqual([]);
  });
});
