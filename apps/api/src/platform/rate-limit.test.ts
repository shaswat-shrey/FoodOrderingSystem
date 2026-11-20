import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { MemoryRateLimiter, RedisRateLimiter } from './rate-limit';

describe('MemoryRateLimiter', () => {
  it('allows up to the limit per window, then resets', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 3; i += 1) expect((await limiter.hit('k', 3, 60)).allowed).toBe(true);
    const blocked = await limiter.hit('k', 3, 60);
    expect(blocked).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    now = 60_001;
    expect((await limiter.hit('k', 3, 60)).allowed).toBe(true);
  });
});

describe('RedisRateLimiter', () => {
  it('falls back to memory limits when Redis is unreachable (fail closed)', async () => {
    const redis = new Redis('redis://127.0.0.1:6999', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    redis.on('error', () => {});
    const limiter = new RedisRateLimiter(redis, createLogger({ level: 'silent', service: 'api' }));
    expect((await limiter.hit('login:ip', 1, 60)).allowed).toBe(true);
    expect((await limiter.hit('login:ip', 1, 60)).allowed).toBe(false);
    redis.disconnect();
  });
});
