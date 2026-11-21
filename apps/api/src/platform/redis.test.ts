import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { BullJobQueue } from './jobs';
import { createLogger } from './logger';
import { RedisRateLimiter } from './rate-limit';
import { closeRedis, redisReady, RedisUnavailableError, softRedis } from './redis';

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

describe('Redis outage fallbacks (NFR-AVAIL-004)', () => {
  const down = () => {
    const client = new Redis('redis://127.0.0.1:6999', { maxRetriesPerRequest: null });
    client.on('error', () => {});
    return client;
  };

  it('answers best-effort calls with the fallback at once instead of queueing them', async () => {
    const client = down();
    const started = Date.now();
    expect(redisReady(client)).toBe(false);
    expect(await softRedis(client, (r) => r.get('k'), 'fallback')).toBe('fallback');
    expect(Date.now() - started).toBeLessThan(100);
    client.disconnect();
  });

  it('falls back to in-memory rate limits without waiting', async () => {
    const client = down();
    const limiter = new RedisRateLimiter(client, createLogger({ level: 'silent', service: 'api' }));
    const started = Date.now();
    for (let i = 0; i < 3; i++) await limiter.hit('login:x', 2, 60);
    expect((await limiter.hit('login:x', 2, 60)).allowed).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
    client.disconnect();
  });

  it('refuses to enqueue while disconnected, so callers fall back to their sweepers', async () => {
    const client = down();
    const jobs = new BullJobQueue(client);
    await expect(jobs.enqueue('orders', 'x', {})).rejects.toBeInstanceOf(RedisUnavailableError);
    client.disconnect();
  });
});
