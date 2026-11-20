import type { PrismaClient } from '@fos/db';
import type { Env } from './config/env';
import { appOrigins } from './config/env';
import type { Clock } from './platform/clock';
import type { Logger } from './platform/logger';
import { RedisRateLimiter, type RateLimiter } from './platform/rate-limit';
import type { RedisClients } from './platform/redis';
import { AuditService } from './modules/audit';
import { BranchRepository, MenuService, ServiceabilityService } from './modules/catalog';
import { SettingsService } from './modules/config';
import { AddressService, FavoritesService, ProfileService } from './modules/customers';
import { CartService, QuoteBuilder } from './modules/checkout';
import { DiscoveryService } from './modules/discovery';
import { OffersService } from './modules/offers';
import { PricingConfigService } from './modules/pricing';
import { SearchService } from './modules/search';
import {
  EstimatedRouting,
  GeoService,
  MockGeocoder,
  UnavailableGeocoder,
  type GeocodingProvider,
} from './modules/geo';
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
  /** Overrides the geocoder (tests inject failing providers). */
  geocoder?: GeocodingProvider;
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
  const settings = new SettingsService(prisma, logger);
  const geocoder =
    input.geocoder ??
    (env.GEO_PROVIDER === 'mock' ? new MockGeocoder() : new UnavailableGeocoder());
  const geo = new GeoService(prisma, geocoder, logger, () => clock.now());
  const routing = new EstimatedRouting(async () => ({
    roadFactor: await settings.get('geo.roadFactor'),
    kmph: await settings.get('geo.motorbikeKmph'),
  }));
  const profiles = new ProfileService(prisma, clock);
  const branches = new BranchRepository(prisma);
  const serviceability = new ServiceabilityService(prisma, branches, routing, settings, clock);
  const addresses = new AddressService(prisma, geo, serviceability, settings);
  const menus = new MenuService(prisma, redis.cache, logger);
  const discovery = new DiscoveryService(
    prisma,
    branches,
    serviceability,
    menus,
    settings,
    redis.cache,
    clock,
    logger,
  );
  const search = new SearchService(prisma, discovery, menus, settings, clock);
  const favorites = new FavoritesService(prisma, discovery, branches, menus, clock);
  const pricingConfig = new PricingConfigService(prisma);
  const quotes = new QuoteBuilder(serviceability, routing, pricingConfig, clock);
  const offers = new OffersService(prisma, clock);
  const cart = new CartService(prisma, branches, menus, quotes, offers, settings, clock);
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
    settings,
    profiles,
    geo,
    routing,
    branches,
    serviceability,
    addresses,
    menus,
    discovery,
    search,
    favorites,
    pricingConfig,
    quotes,
    offers,
    cart,
    appOrigins: appOrigins(env),
  };
}

export type Container = ReturnType<typeof createContainer>;
