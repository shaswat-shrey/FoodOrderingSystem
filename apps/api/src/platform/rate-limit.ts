import type { Redis } from 'ioredis';
import type { Logger } from './logger';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one hit for `key` in a fixed window of `windowSeconds`, allowing `limit` hits. */
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Current count for `key` without counting a hit. */
  peek(key: string): Promise<number>;
  /** Clears a key (e.g. after a successful login). */
  reset(key: string): Promise<void>;
}

/** Per-process fallback. Limits are per instance, so they are weaker but never absent. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = this.now();
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.windows.set(key, entry);
    }
    entry.count += 1;
    if (this.windows.size > 50_000) this.prune(now);
    return {
      allowed: entry.count <= limit,
      remaining: Math.max(0, limit - entry.count),
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  async peek(key: string): Promise<number> {
    const entry = this.windows.get(key);
    return entry && entry.resetAt > this.now() ? entry.count : 0;
  }

  async reset(key: string): Promise<void> {
    this.windows.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.windows) if (entry.resetAt <= now) this.windows.delete(key);
  }
}

/**
 * Fixed-window limiter on the core Redis (shared across instances). If Redis
 * fails, it falls back to per-instance memory limits so auth endpoints stay
 * throttled (fail closed — NFR-AVAIL-004).
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly fallback = new MemoryRateLimiter();
  private warned = false;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly prefix = 'rl:',
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = this.prefix + key;
    try {
      const result = await this.redis
        .multi()
        .incr(redisKey)
        .expire(redisKey, windowSeconds, 'NX')
        .ttl(redisKey)
        .exec();
      if (!result) throw new Error('rate limit transaction aborted');
      const count = Number(result[0]?.[1]);
      const ttl = Number(result[2]?.[1]);
      this.warned = false;
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
      };
    } catch (error) {
      if (!this.warned) {
        this.logger.warn({ err: error }, 'rate limiter using in-memory fallback');
        this.warned = true;
      }
      return this.fallback.hit(key, limit, windowSeconds);
    }
  }

  async peek(key: string): Promise<number> {
    try {
      return Number((await this.redis.get(this.prefix + key)) ?? 0);
    } catch {
      return this.fallback.peek(key);
    }
  }

  async reset(key: string): Promise<void> {
    await Promise.allSettled([this.redis.del(this.prefix + key), this.fallback.reset(key)]);
  }
}
