import { createHash } from 'node:crypto';
import type { CheckoutSession, PrismaClient } from '@fos/db';
import type { CreateCheckoutBody } from '@fos/validation';
import type { ApiErrorDetail } from '@fos/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { BranchRecord } from '../catalog';
import type { SettingsService } from '../config';
import type { AddressService, AddressView } from '../customers';
import type { WalletService } from '../ledger';
import { PRICING_VERSION, type PricingConfigService, type Quote } from '../pricing';
import type { CartService, Evaluated, Issue } from './cart.service';

type Method = 'ONLINE' | 'COD' | 'WALLET';

export interface CheckoutOptions {
  addressId: string;
  paymentMethod: Method;
  useWallet: boolean;
  tipAmount: number;
  deliveryInstructions?: string | undefined;
  contactless: boolean;
  contactName?: string | undefined;
  contactPhone?: string | undefined;
}

/** What a session stores beside the quote (FR-CHK-001 step 3). */
export interface SessionSnapshot {
  quote: Quote;
  branchId: string;
  delivery: { distanceKm: number; eta: { minMinutes: number; maxMinutes: number } } | null;
  address: Omit<AddressView, 'createdAt' | 'updatedAt' | 'serviceability'>;
  configVersions: { pricingVersion: number; feeScheduleId: string; taxRuleIds: string[] };
}

/** Issue codes that map straight to their own error (others become CART_INVALID). */
const DIRECT = new Set([
  'CART_EMPTY',
  'ITEM_UNAVAILABLE', // E02: with the affected line ids in details
  'BRANCH_NOT_ACCEPTING_ORDERS',
  'ADDRESS_NOT_SERVICEABLE',
  'ORDER_BELOW_MINIMUM',
  'ORDER_ABOVE_MAXIMUM',
  'COUPON_INVALID',
  'COUPON_EXPIRED',
  'COUPON_NOT_APPLICABLE',
  'COUPON_LIMIT_REACHED',
]);

/** Snapshot hash of the cart (lines, quantities, coupon) checked again at confirmation (FR-CHK-002). */
export function cartHash(evaluated: Evaluated): string {
  const lines = evaluated.cart.items.map((i) => `${i.configHash}:${i.quantity}`).sort();
  return createHash('sha256')
    .update(JSON.stringify([evaluated.cart.branchId, lines, evaluated.cart.couponId ?? '']))
    .digest('hex');
}

/** FR-CHK-001, 003…007; confirmation and order creation arrive with orders (Phase 7). */
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cart: CartService,
    private readonly addresses: AddressService,
    private readonly wallet: WalletService,
    private readonly pricingConfig: PricingConfigService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /** BR-PAY-002 / BR-PAY-007 / FR-CHK-007: which methods this order can use, and why not. */
  async methods(
    userId: string,
    branch: Pick<BranchRecord, 'restaurant'> & { restaurantId: string },
    amount: number,
  ) {
    const [codCap, profile, restaurant, walletBalance] = await Promise.all([
      this.settings.get('cod.maxOrderAmount'),
      this.prisma.customerProfile.findUnique({ where: { userId }, select: { codBlocked: true } }),
      this.prisma.restaurant.findUnique({
        where: { id: branch.restaurantId },
        select: { codEnabled: true },
      }),
      this.wallet.available(userId),
    ]);
    let codReason: string | null = null;
    if (!restaurant?.codEnabled) codReason = `${branch.restaurant.brandName} doesn't accept cash.`;
    else if (profile?.codBlocked)
      codReason =
        'Cash on delivery is unavailable on your account after recent refused deliveries.';
    else if (amount > codCap)
      codReason = `Cash on delivery is available up to ₹${(codCap / 100).toFixed(0)}.`;
    return [
      { method: 'ONLINE' as const, available: true, reason: null },
      { method: 'COD' as const, available: codReason === null, reason: codReason },
      {
        method: 'WALLET' as const,
        available: walletBalance >= amount && amount > 0,
        reason:
          walletBalance >= amount ? null : `Your wallet has ₹${(walletBalance / 100).toFixed(2)}.`,
        balance: walletBalance,
      },
    ];
  }

  async quoteFor(userId: string, opts: CheckoutOptions) {
    if (opts.paymentMethod === 'COD' && opts.useWallet) {
      throw new AppError('COD_NOT_AVAILABLE', {
        message: "Wallet credits can't be combined with cash on delivery.",
      }); // BR-PAY-007
    }
    if (opts.contactless && opts.paymentMethod === 'COD') {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Contactless delivery needs a prepaid order.',
        details: [
          { path: 'contactless', code: 'PREPAID_ONLY', message: 'Contactless requires prepaid' },
        ],
      }); // BR-DEL-009
    }
    const address = await this.addresses.get(userId, opts.addressId);
    const useWallet = opts.paymentMethod === 'WALLET' || opts.useWallet;
    const balance = useWallet ? await this.wallet.available(userId) : 0;
    const evaluated = await this.cart.evaluate(userId, {
      point: address.location,
      tipAmount: opts.tipAmount,
      paymentMethod: opts.paymentMethod,
      wallet: { use: useWallet, balance },
    });
    if (!evaluated || !evaluated.branch || !evaluated.view.preview) {
      throw new AppError('CART_EMPTY', { message: 'Your cart is empty.' });
    }
    const blocking: Issue[] = evaluated.view.blocking;
    if (blocking.length > 0) {
      const details: ApiErrorDetail[] = blocking.map((i) => ({
        code: i.code,
        message: i.message,
        ...(i.lineId ? { path: `lines.${i.lineId}` } : {}),
      }));
      const first = blocking[0]!;
      const code =
        blocking.every((i) => i.code === first.code) && DIRECT.has(first.code)
          ? first.code
          : 'CART_INVALID';
      throw new AppError(code as 'CART_INVALID', {
        message: blocking.length === 1 ? first.message : 'Some items in your cart need attention.',
        details,
      });
    }
    const quote = evaluated.view.preview;
    if (opts.paymentMethod === 'WALLET' && quote.payable > 0) {
      throw new AppError('INSUFFICIENT_WALLET_BALANCE', {
        message: `Your wallet is ₹${(quote.payable / 100).toFixed(2)} short. Pay the rest online.`,
      });
    }
    if (opts.paymentMethod === 'COD') {
      const cod = (await this.methods(userId, evaluated.branch, quote.payable)).find(
        (m) => m.method === 'COD',
      )!;
      if (!cod.available)
        throw new AppError('COD_NOT_AVAILABLE', { message: cod.reason ?? undefined });
    }
    const taxRules = await this.pricingConfig.taxRules(this.clock.now());
    const { createdAt: _c, updatedAt: _u, serviceability: _s, ...addressSnapshot } = address;
    const snapshot: SessionSnapshot = {
      quote,
      branchId: evaluated.branch.id,
      delivery: evaluated.view.delivery
        ? { distanceKm: evaluated.view.delivery.distanceKm, eta: evaluated.view.delivery.eta }
        : null,
      address: addressSnapshot,
      configVersions: {
        pricingVersion: PRICING_VERSION,
        feeScheduleId: quote.feeScheduleId,
        taxRuleIds: taxRules.map((t) => t.id),
      },
    };
    // The customer is now looking at these prices (BR-CART-005).
    await this.cart.acknowledgePrices(
      evaluated.cart.id,
      evaluated.priced.map((l) => ({ lineId: l.lineId, unitAmount: l.resolved.unitAmount })),
    );
    return { evaluated, address, snapshot };
  }

  private async expiry(): Promise<Date> {
    return new Date(
      this.clock.now().getTime() + (await this.settings.get('checkout.sessionTtlSeconds')) * 1000,
    );
  }

  /** API-CHK-001: a fresh session replaces any open one (BR-ORDER-001 TTL). */
  async create(userId: string, body: CreateCheckoutBody) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { fullName: true },
    });
    if (user.fullName.trim().length < 2)
      throw new AppError('VALIDATION_ERROR', { message: 'Add your name to your profile first.' });
    const { evaluated, address, snapshot } = await this.quoteFor(userId, body);
    const session = await this.prisma.$transaction(async (tx) => {
      await tx.checkoutSession.updateMany({
        where: { userId, status: 'OPEN' },
        data: { status: 'EXPIRED' },
      });
      return tx.checkoutSession.create({
        data: {
          userId,
          cartId: evaluated.cart.id,
          cartHash: cartHash(evaluated),
          addressId: address.id,
          paymentMethod: body.paymentMethod,
          useWallet: body.paymentMethod === 'WALLET' || body.useWallet,
          tipAmount: body.tipAmount,
          deliveryInstructions: body.deliveryInstructions ?? null,
          contactless: body.contactless,
          contactName: body.contactName ?? address.contactName,
          contactPhone: body.contactPhone ?? address.contactPhone,
          quote: snapshot as object,
          payableAmount: snapshot.quote.payable,
          feeScheduleId: snapshot.quote.feeScheduleId,
          expiresAt: await this.expiry(),
        },
      });
    });
    return this.view(session);
  }

  async owned(userId: string, sessionId: string): Promise<CheckoutSession> {
    const session = await this.prisma.checkoutSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) throw new AppError('NOT_FOUND', { message: "We couldn't find that checkout." });
    if (session.status === 'OPEN' && session.expiresAt <= this.clock.now()) {
      await this.prisma.checkoutSession.updateMany({
        where: { id: session.id, status: 'OPEN' },
        data: { status: 'EXPIRED' },
      });
      return { ...session, status: 'EXPIRED' };
    }
    return session;
  }

  /** API-CHK-002 */
  async get(userId: string, sessionId: string) {
    return this.view(await this.owned(userId, sessionId));
  }

  /** API-CHK-003: changes re-quote the same OPEN session and restart its timer. */
  async update(
    userId: string,
    sessionId: string,
    patch: Partial<CheckoutOptions> & { version?: number | undefined },
  ) {
    const session = await this.owned(userId, sessionId);
    if (session.status === 'CONFIRMED') throw new AppError('CHECKOUT_SESSION_CONSUMED');
    if (session.status !== 'OPEN') throw new AppError('CHECKOUT_SESSION_EXPIRED');
    if (patch.version !== undefined && patch.version !== session.version) {
      throw new AppError('CONFLICT_STALE_VERSION', {
        message: 'Checkout changed in another tab. Please refresh.',
      });
    }
    const opts: CheckoutOptions = {
      addressId: patch.addressId ?? session.addressId,
      paymentMethod: patch.paymentMethod ?? session.paymentMethod,
      useWallet: patch.useWallet ?? session.useWallet,
      tipAmount: patch.tipAmount ?? session.tipAmount,
      deliveryInstructions: patch.deliveryInstructions ?? session.deliveryInstructions ?? undefined,
      contactless: patch.contactless ?? session.contactless,
      contactName:
        patch.contactName ?? (patch.addressId ? undefined : (session.contactName ?? undefined)),
      contactPhone:
        patch.contactPhone ?? (patch.addressId ? undefined : (session.contactPhone ?? undefined)),
    };
    // Switching to cash turns wallet use off rather than failing (BR-PAY-007), unless the client said otherwise.
    if (patch.paymentMethod === 'COD' && patch.useWallet === undefined) opts.useWallet = false;
    const { evaluated, address, snapshot } = await this.quoteFor(userId, opts);
    const updated = await this.prisma.checkoutSession.updateMany({
      where: { id: session.id, status: 'OPEN', version: session.version },
      data: {
        cartHash: cartHash(evaluated),
        addressId: address.id,
        paymentMethod: opts.paymentMethod,
        useWallet: opts.paymentMethod === 'WALLET' || opts.useWallet,
        tipAmount: opts.tipAmount,
        deliveryInstructions: opts.deliveryInstructions ?? null,
        contactless: opts.contactless,
        contactName: opts.contactName ?? address.contactName,
        contactPhone: opts.contactPhone ?? address.contactPhone,
        quote: snapshot as object,
        payableAmount: snapshot.quote.payable,
        feeScheduleId: snapshot.quote.feeScheduleId,
        expiresAt: await this.expiry(),
        version: { increment: 1 },
      },
    });
    if (updated.count === 0)
      throw new AppError('CONFLICT_STALE_VERSION', {
        message: 'Checkout changed in another tab. Please refresh.',
      });
    return this.get(userId, sessionId);
  }

  /** Re-runs every check and the quote for an existing session (FR-CHK-002 step 2). */
  async revalidate(userId: string, session: CheckoutSession) {
    return this.quoteFor(userId, {
      addressId: session.addressId,
      paymentMethod: session.paymentMethod,
      useWallet: session.useWallet,
      tipAmount: session.tipAmount,
      deliveryInstructions: session.deliveryInstructions ?? undefined,
      contactless: session.contactless,
      contactName: session.contactName ?? undefined,
      contactPhone: session.contactPhone ?? undefined,
    });
  }

  private view(session: CheckoutSession) {
    const snapshot = session.quote as unknown as SessionSnapshot;
    return {
      id: session.id,
      status: session.status,
      version: session.version,
      expiresAt: session.expiresAt,
      branchId: snapshot.branchId,
      address: snapshot.address,
      paymentMethod: session.paymentMethod,
      useWallet: session.useWallet,
      tipAmount: session.tipAmount,
      deliveryInstructions: session.deliveryInstructions,
      contactless: session.contactless,
      contact: { name: session.contactName, phone: session.contactPhone },
      delivery: snapshot.delivery,
      quote: snapshot.quote,
      payableAmount: session.payableAmount,
    };
  }
}
