import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { closeRedis } from './redis';

describe('closeRedis (NFR-REL-007)', () => {
  it('returns promptly for a client that cannot connect', async () => {
    const client = new Redis('redis://127.0.0.1:6999', {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    client.on('error', () => {});
    const ended = new Promise<void>((resolve) => client.once('end', () => resolve()));
    const started = Date.now();
    await closeRedis(client);
    await ended;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client.status).toBe('end');
  });
});
