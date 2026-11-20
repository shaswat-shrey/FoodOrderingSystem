import type { PrismaClient } from '@fos/db';
import type { Env } from './config/env';
import { appOrigins } from './config/env';
import type { Clock } from './platform/clock';
import type { Logger } from './platform/logger';
import { RedisRateLimiter, type RateLimiter } from './platform/rate-limit';
import type { RedisClients } from './platform/redis';
import { AuditService } from './modules/audit';
import { AuthService, OtpService, SessionService, TokenService } from './modules/auth';
import { IamService } from './modules/iam';
import type { MessageDispatcher } from './modules/notifications';

export interface ContainerInput {
  env: Env;
  prisma: PrismaClient;
  redis: RedisClients;
  logger: Logger;
  clock: Clock;
  messages: MessageDispatcher;
  limiter?: RateLimiter;
}

/** Composition root: builds every service once per process (SYSTEM-ARCHITECTURE §3). */
export function createContainer(input: ContainerInput) {
  const { env, prisma, redis, logger, clock, messages } = input;
  const limiter = input.limiter ?? new RedisRateLimiter(redis.core, logger);
  const iam = new IamService(prisma, redis.cache, logger);
  const audit = new AuditService(prisma);
  const tokens = new TokenService(env.JWT_SIGNING_KEYS, env.JWT_ISSUER, clock);
  const sessions = new SessionService(prisma, redis.core, clock, logger);
  const otp = new OtpService(prisma, env.AUTH_HMAC_SECRET, clock);
  const auth = new AuthService(
    prisma,
    sessions,
    tokens,
    otp,
    iam,
    audit,
    messages,
    limiter,
    clock,
    logger,
    {
      hmacSecret: env.AUTH_HMAC_SECRET,
      appUrls: env.APP_URLS,
    },
  );
  return {
    env,
    prisma,
    redis,
    logger,
    clock,
    messages,
    limiter,
    iam,
    audit,
    tokens,
    sessions,
    otp,
    auth,
    appOrigins: appOrigins(env),
  };
}

export type Container = ReturnType<typeof createContainer>;
