import {
  DeliveryStagesService,
  DispatchService,
  OrderTrackingService,
  registerDispatchConsumers,
} from './modules/dispatch';
import { registerReviewConsumers, ReviewService } from './modules/reviews';
import {
  LiveTracking,
  registerRealtimeConsumers,
  RoomPolicy,
  wireRealtime,
} from './modules/realtime';
import { RedisRealtime, type Realtime } from './platform/realtime/publisher';
import type { PartnerSocketHandlers } from './platform/realtime/socket-server';
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
import { createStorageProvider, FilesService, type StorageProvider } from './modules/files';
import { AddressService, FavoritesService, ProfileService } from './modules/customers';
import { CartService, CheckoutService, QuoteBuilder } from './modules/checkout';
import { DiscoveryService } from './modules/discovery';
import { LedgerService, WalletService } from './modules/ledger';
import { OffersService } from './modules/offers';
import {
  InvoiceService,
  OrderCancellationService,
  OrderIssueService,
  OrderQueryService,
  OrderSettlement,
  ReorderService,
  RestaurantOrdersService,
  OrderCreationService,
  OrderEffects,
  OrderPaymentReactions,
  OrderTimerJobs,
  OrderTimers,
  OrderTransitions,
  registerOrderConsumers,
} from './modules/orders';
import { OutboxRelay } from './platform/outbox-relay';
import {
  createPaymentProvider,
  PaymentsService,
  RefundService,
  type PaymentProvider,
} from './modules/payments';
import { BullJobQueue, type JobQueue } from './platform/jobs';
import { PricingConfigService } from './modules/pricing';
import { SearchService } from './modules/search';
import { SupportService } from './modules/support';
import {
  EstimatedRouting,
  GeoService,
  MockGeocoder,
  UnavailableGeocoder,
  type GeocodingProvider,
} from './modules/geo';
import {
  AuthService,
  OtpService,
  REALTIME_CONTROL_CHANNEL,
  SessionService,
  TokenService,
} from './modules/auth';
import { IamService } from './modules/iam';
import {
  BranchOpsService,
  MenuAdminService,
  MerchantAccess,
  OnboardingService,
  PermissionChanges,
  RestaurantAnalyticsService,
  RestaurantProfileService,
  StaffService,
} from './modules/merchant';
import {
  PartnerAvailabilityService,
  PartnerEarningsService,
  PartnerFinanceService,
  PartnerOnboardingService,
  PresenceStore,
} from './modules/partners';
import { fieldCipherFrom } from './platform/crypto';
import { AdminMerchantsService, AdminPartnersService, AdminUsersService } from './modules/admin';
import {
  NotificationService,
  registerNotificationConsumers,
  type MessageDispatcher,
} from './modules/notifications';

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
  paymentProvider?: PaymentProvider;
  jobs?: JobQueue;
  storage?: StorageProvider;
  /** Overrides socket pushes (tests record them). */
  realtime?: Realtime;
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
  const files = new FilesService(
    prisma,
    input.storage ?? createStorageProvider(env, env.AUTH_HMAC_SECRET),
    audit,
    clock,
    logger,
  );
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
  const ledger = new LedgerService(prisma);
  const wallet = new WalletService(prisma, ledger, clock);
  const offers = new OffersService(prisma, clock);
  const cart = new CartService(prisma, branches, menus, quotes, offers, settings, clock);
  const checkout = new CheckoutService(
    prisma,
    cart,
    addresses,
    wallet,
    pricingConfig,
    settings,
    clock,
  );
  const jobs = input.jobs ?? new BullJobQueue(redis.core);
  const paymentProvider = input.paymentProvider ?? createPaymentProvider(env);
  const refunds = new RefundService(prisma, paymentProvider, ledger, wallet, jobs, clock, logger);
  const payments = new PaymentsService(
    prisma,
    paymentProvider,
    ledger,
    refunds,
    audit,
    jobs,
    clock,
    logger,
  );
  const orderTransitions = new OrderTransitions(clock);
  const orderTimers = new OrderTimers(jobs, settings, logger, clock);
  const orderCreation = new OrderCreationService(
    prisma,
    checkout,
    offers,
    wallet,
    payments,
    paymentProvider,
    pricingConfig,
    orderTimers,
    env.AUTH_HMAC_SECRET,
    clock,
    logger,
  );
  const orderEffects = new OrderEffects(offers, wallet);
  const orderPaymentReactions = new OrderPaymentReactions(
    prisma,
    orderTransitions,
    orderEffects,
    payments,
    refunds,
    orderTimers,
    logger,
  );
  const orderTimerJobs = new OrderTimerJobs(
    prisma,
    orderTransitions,
    orderPaymentReactions,
    orderTimers,
    clock,
    logger,
  );
  const orderCancellation = new OrderCancellationService(
    prisma,
    orderTransitions,
    orderEffects,
    payments,
    refunds,
    ledger,
    settings,
    env.AUTH_HMAC_SECRET,
    clock,
    logger,
  );
  orderTimerJobs.onAcceptTimeout = (orderId) => orderCancellation.acceptTimeout(orderId);
  const orderQueries = new OrderQueryService(prisma);
  const reorders = new ReorderService(prisma, cart);
  const invoices = new InvoiceService(prisma, clock);
  const orderSettlement = new OrderSettlement(ledger);
  const support = new SupportService(prisma, settings, clock);
  const orderIssues = new OrderIssueService(prisma, support, refunds, settings, clock);
  // Consumers are registered here; the relay loop itself runs in the worker.
  const outboxRelay = new OutboxRelay(prisma, redis.core, clock, logger);
  const notifications = new NotificationService(prisma, jobs, clock, logger);
  const fieldCipher = fieldCipherFrom(env);
  const merchantAccess = new MerchantAccess(prisma, iam);
  const permissionChanges = new PermissionChanges(iam, sessions);
  const onboarding = new OnboardingService(
    prisma,
    files,
    serviceability,
    permissionChanges,
    audit,
    fieldCipher,
    clock,
  );
  const branchOps = new BranchOpsService(prisma, branches, settings, audit, clock, logger);
  const restaurantProfile = new RestaurantProfileService(prisma, files, audit, fieldCipher, clock);
  const menuAdmin = new MenuAdminService(prisma, files, audit, clock);
  const staff = new StaffService(
    prisma,
    messages,
    permissionChanges,
    audit,
    clock,
    env.APP_URLS.RESTAURANT,
  );
  const restaurantAnalytics = new RestaurantAnalyticsService(prisma, clock);
  const partnerOnboarding = new PartnerOnboardingService(
    prisma,
    files,
    permissionChanges,
    audit,
    fieldCipher,
    clock,
  );
  const presence = new PresenceStore(redis.core);
  const partnerAvailability = new PartnerAvailabilityService(
    prisma,
    presence,
    serviceability,
    ledger,
    settings,
    clock,
    logger,
  );
  const dispatch = new DispatchService(
    prisma,
    redis.core,
    presence,
    partnerAvailability,
    ledger,
    settings,
    jobs,
    clock,
    logger,
  );
  const partnerEarnings = new PartnerEarningsService(prisma, ledger, settings, clock);
  dispatch.onCompensate = (tx, delivery, stage) =>
    partnerEarnings.compensate(tx, delivery, stage).then(() => undefined);
  const deliveryStages = new DeliveryStagesService(
    prisma,
    orderTransitions,
    orderTimers,
    orderSettlement,
    partnerEarnings,
    ledger,
    presence,
    partnerAvailability,
    dispatch,
    files,
    audit,
    settings,
    env.AUTH_HMAC_SECRET,
    clock,
    logger,
  );
  const reviews = new ReviewService(prisma, files, settings, clock);
  const tracking = new OrderTrackingService(prisma, presence, env.AUTH_HMAC_SECRET, clock);
  const partnerFinance = new PartnerFinanceService(
    prisma,
    partnerAvailability,
    settings,
    audit,
    fieldCipher,
    reviews,
    clock,
  );
  partnerAvailability.onLeave = (partnerId) => dispatch.withdrawFor(partnerId);
  partnerAvailability.onIdle = (partnerId) => dispatch.partnerIdle(partnerId);
  // BR-DEL-003: nobody would deliver it — cancel as a platform fault with a full refund.
  dispatch.onNoPartner = (orderId) =>
    orderCancellation
      .cancel({ orderId, actor: { type: 'SYSTEM' }, reasonCode: 'NO_PARTNER', fault: 'PLATFORM' })
      .then(() => undefined)
      .catch((error: unknown) =>
        logger.warn({ err: error, orderId }, 'no-partner cancellation skipped'),
      );
  const restaurantOrders = new RestaurantOrdersService(
    prisma,
    orderTransitions,
    orderCancellation,
    orderTimers,
    orderSettlement,
    audit,
    clock,
  );
  registerOrderConsumers(outboxRelay, { prisma, reactions: orderPaymentReactions, invoices });
  registerNotificationConsumers(outboxRelay, { prisma, notifications });
  registerDispatchConsumers(outboxRelay, dispatch);
  const realtime =
    input.realtime ?? new RedisRealtime(redis.core, REALTIME_CONTROL_CHANNEL, logger);
  const rooms = new RoomPolicy(prisma, iam, () => clock.now());
  const liveTracking = new LiveTracking(prisma, redis.core, realtime, presence, routing, clock);
  wireRealtime({ realtime, dispatch, partnerAvailability, notifications, liveTracking });
  registerRealtimeConsumers(outboxRelay, { prisma, realtime, offers: dispatch });
  // EVT-C-004…006: the delivery namespace's client events.
  const partnerSocket: PartnerSocketHandlers = {
    location: async (userId, f) => {
      await partnerAvailability.ingest(userId, [
        {
          lat: f.lat,
          lng: f.lng,
          accuracyM: f.accuracy,
          recordedAt: f.recordedAt ? new Date(f.recordedAt) : undefined,
          heading: f.heading === undefined ? undefined : Math.round(f.heading) % 360,
          speedKmh: f.speed === undefined ? undefined : Math.round(f.speed),
        },
      ]);
    },
    // Liveness comes from location fixes (FR-RT-021); the heartbeat only confirms the socket.
    heartbeat: async () => undefined,
    offerAck: async (userId, offerId) => {
      await prisma.deliveryAssignment.updateMany({
        where: { id: offerId, displayedAt: null, partner: { userId } },
        data: { displayedAt: clock.now() },
      });
    },
  };
  registerReviewConsumers(outboxRelay, reviews);
  const adminPartners = new AdminPartnersService(
    prisma,
    partnerOnboarding,
    partnerAvailability,
    partnerFinance,
    presence,
    ledger,
    audit,
  );
  const adminUsers = new AdminUsersService(prisma, sessions, wallet, adminPartners, audit, clock);
  const adminMerchants = new AdminMerchantsService(
    prisma,
    onboarding,
    restaurantProfile,
    pricingConfig,
    permissionChanges,
    orderCancellation,
    files,
    fieldCipher,
    audit,
    clock,
    logger,
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
    settings,
    files,
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
    ledger,
    wallet,
    offers,
    cart,
    checkout,
    jobs,
    paymentProvider,
    refunds,
    payments,
    orderTransitions,
    orderTimers,
    orderCreation,
    orderEffects,
    orderPaymentReactions,
    orderTimerJobs,
    orderCancellation,
    orderQueries,
    reorders,
    invoices,
    orderSettlement,
    support,
    orderIssues,
    notifications,
    fieldCipher,
    merchantAccess,
    permissionChanges,
    onboarding,
    branchOps,
    restaurantProfile,
    menuAdmin,
    staff,
    restaurantAnalytics,
    partnerOnboarding,
    presence,
    partnerAvailability,
    dispatch,
    partnerEarnings,
    partnerFinance,
    reviews,
    tracking,
    deliveryStages,
    realtime,
    rooms,
    liveTracking,
    partnerSocket,
    restaurantOrders,
    adminUsers,
    adminMerchants,
    adminPartners,
    outboxRelay,
    appOrigins: appOrigins(env),
  };
}

export type Container = ReturnType<typeof createContainer>;
