import { Redis } from 'ioredis';
import type { Logger } from './logger';

export interface RedisClients {
  /** Queues, locks, rate limits, sessions, socket adapter, live geo state (noeviction). */
  core: Redis;
  /** Disposable cache (allkeys-lru). */
  cache: Redis;
}

/**
 * Logs the first error of an outage and the recovery, instead of one line per
 * reconnect attempt. Every ioredis client needs an error listener, otherwise
 * Node treats connection errors as unhandled.
 */
export function attachConnectionLogging(client: Redis, name: string, logger: Logger): void {
  let failing = false;
  client.on('error', (error) => {
    if (failing) return;
    failing = true;
    logger.warn({ err: error, redis: name }, 'redis unavailable; retrying in background');
  });
  client.on('ready', () => {
    if (failing) logger.info({ redis: name }, 'redis recovered');
    else logger.info({ redis: name }, 'redis ready');
    failing = false;
  });
}

/** Creates one named Redis client with connection logging attached. */
export function connectRedis(url: string, name: string, logger: Logger): Redis {
  const client = new Redis(url, {
    connectionName: `fos-${name}`,
    // BullMQ requires this for blocking connections; harmless for others.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  attachConnectionLogging(client, name, logger);
  return client;
}

export function createRedisClients(urls: { core: string; cache: string }, logger: Logger): RedisClients {
  return { core: connectRedis(urls.core, 'core', logger), cache: connectRedis(urls.cache, 'cache', logger) };
}

export async function pingRedis(client: Redis): Promise<void> {
  const reply = await client.ping();
  if (reply !== 'PONG') throw new Error(`unexpected PING reply: ${reply}`);
}

/**
 * Closes a client without hanging: QUIT is queued until a connection exists,
 * so a client that is down (reconnecting) must be disconnected instead.
 */
export async function closeRedis(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    await client.quit();
  } else {
    client.disconnect();
  }
}
