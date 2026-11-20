import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env';
import { createHealthServer } from './health-server';
import { buildRegistrations, createMessageSink } from './processors';
import { createLogger } from '@fos/api/platform';
import type { Message, MessageSink } from '@fos/api/notifications';

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
    expect(loadWorkerEnv({ REDIS_CORE_URL: 'redis://localhost:6379' }).WORKER_HEALTH_PORT).toBe(
      4001,
    );
    expect(() => loadWorkerEnv({})).toThrow(/REDIS_CORE_URL/);
  });

  it('reports ready only when Redis is reachable', async () => {
    const ok = await fetch(`${await serve(true)}/health/ready`);
    expect(ok.status).toBe(200);
    close?.();
    const down = await fetch(`${await serve(false)}/health/ready`);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({
      status: 'unavailable',
      checks: { redisCore: { error: 'unreachable' } },
    });
  });

  it('delivers queued account messages through the configured sink', async () => {
    const delivered: Message[] = [];
    const sink: MessageSink = { deliver: async (m) => void delivered.push(m) };
    const [notifications] = buildRegistrations(sink);
    const message: Message = {
      channel: 'SMS',
      to: '+919000000101',
      template: 'OTP',
      vars: { code: '123456', purpose: 'LOGIN', minutes: 5 },
    };
    await notifications!.processor({ name: 'send-message', data: message } as never);
    expect(delivered).toEqual([message]);
  });

  it('refuses dev sinks in production', () => {
    const env = loadWorkerEnv({ NODE_ENV: 'production', REDIS_CORE_URL: 'redis://localhost:6379' });
    expect(() =>
      createMessageSink(env, createLogger({ level: 'silent', service: 'worker' })),
    ).toThrow(/provider/);
  });
});
