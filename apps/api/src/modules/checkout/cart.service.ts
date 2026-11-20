import type { Prisma, PrismaClient } from '@fos/db';
import type { AddCartItemBody, MergeCartBody, ReplaceCartLineBody } from '@fos/validation';
import type { ApiErrorDetail } from '@fos/types';
import { uuidv7 } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import {
  isListed,
  type BranchRecord,
  type BranchRepository,
  type DeliveryInfo,
  type MenuService,
} from '../catalog';
import type { SettingsService } from '../config';
import type { LatLng } from '../geo';
import type { Quote } from '../pricing';
import { configHash, resolveLine, type LineProblemCode, type ResolvedLine } from './line-config';
import type { CouponIssue, OfferResolver } from './offers';
import type { QuoteBuilder } from './quote-builder';

/** BR-CART-003 */
export const CART_LIMITS = { lines: 30, units: 50, perLine: 20 } as const;

const cartInclude = {
  items: { include: { options: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.CartInclude;
type CartRow = Prisma.CartGetPayload<{ include: typeof cartInclude }>;
type Tx = Prisma.TransactionClient;

export type LineStatus =
  'OK' | 'PRICE_CHANGED' | 'ITEM_REMOVED' | Exclude<LineProblemCode, 'ITEM_NOT_IN_BRANCH'>;

export interface Issue {
  code: string;
  message: string;
  lineId?: string;
  details?: ApiErrorDetail[];
}

export interface CartLineView {
  id: string;
  foodItemId: string;
  name: string;
  dietaryMarker: string | null;
  variant: { id: string; name: string } | null;
  options: { id: string; name: string; groupName: string }[];
  quantity: number;
  instructions: string | null;
  unitAmount: number | null;
  lineAmount: number | null;
  /** BR-CART-005: flagged, never silently dropped or repriced. */
  status: LineStatus;
  previousUnitAmount: number | null;
  message: string | null;
}

export interface CartView {
  id: string | null;
  version: number;
  branch: {
    id: string;
    restaurantId: string;
    restaurantName: string;
    branchName: string;
    acceptingOrders: boolean;
    minOrderAmount: number;
  } | null;
  lines: CartLineView[];
  itemCount: number;
  instructions: string | null;
  noCutlery: boolean;
  coupon: { id: string; code: string } | null;
  preview: Quote | null;
  delivery: Pick<DeliveryInfo, 'serviceable' | 'reason' | 'distanceKm' | 'eta'> | null;
  blocking: Issue[];
  warnings: Issue[];
}

export interface Evaluated {
  cart: CartRow;
  branch: BranchRecord | null;
  view: CartView;
  /** Valid lines, ready for pricing and order snapshots. */
  priced: { lineId: string; quantity: number; resolved: ResolvedLine }[];
}

const EMPTY = (cart: CartRow | null): CartView => ({
  id: cart?.id ?? null,
  version: cart?.version ?? 0,
  branch: null,
  lines: [],
  itemCount: 0,
  instructions: cart?.instructions ?? null,
  noCutlery: cart?.noCutlery ?? false,
  coupon: null,
  preview: null,
  delivery: null,
  blocking: [{ code: 'CART_EMPTY', message: 'Your cart is empty.' }],
  warnings: [],
});

/** FR-CART-001…013 */
export class CartService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly branches: BranchRepository,
    private readonly menus: MenuService,
    private readonly quotes: QuoteBuilder,
    private readonly offers: OfferResolver,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  private active(userId: string, db: Tx | PrismaClient = this.prisma) {
    return db.cart.findFirst({ where: { userId, status: 'ACTIVE' }, include: cartInclude });
  }

  /** The active cart, created on first use (one per user: partial unique index). */
  private async ensureCart(tx: Tx, userId: string): Promise<CartRow> {
    const existing = await this.active(userId, tx);
    if (existing) return existing;
    await tx.$executeRaw`INSERT INTO carts (id, user_id, status, last_activity_at, updated_at)
      VALUES (${uuidv7()}::uuid, ${userId}::uuid, 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`;
    return (await this.active(userId, tx))!;
  }

  private assertVersion(cart: CartRow, version: number | undefined) {
    if (version !== undefined && version !== cart.version) {
      throw new AppError('CONFLICT_STALE_VERSION', {
        message: 'Your cart changed on another device. Please refresh.',
      });
    }
  }

  private async touch(tx: Tx, cartId: string, data: Prisma.CartUpdateInput = {}) {
    await tx.cart.update({
      where: { id: cartId },
      data: { ...data, version: { increment: 1 }, lastActivityAt: this.clock.now() },
    });
  }

  private async listedBranch(branchId: string): Promise<BranchRecord> {
    const branch = await this.branches.loadOne(branchId, this.clock.now());
    if (!branch || !isListed(branch))
      throw new AppError('NOT_FOUND', { message: "We couldn't find that restaurant." });
    return branch;
  }

  /** Validates one line or throws the specific error (FR-CART-001 errors). */
  private async resolveOrThrow(
    branch: BranchRecord,
    req: Parameters<typeof resolveLine>[1],
  ): Promise<ResolvedLine> {
    const result = resolveLine(await this.menus.raw(branch), req, this.clock.now());
    if (!result.ok) {
      throw new AppError(
        result.code === 'OPTION_UNAVAILABLE' ? 'CUSTOMIZATION_INVALID' : result.code,
        {
          message: result.message,
          details: result.details,
        },
      );
    }
    return result;
  }

  private assertLimits(cart: CartRow, change: { addLine: boolean; unitDelta: number }) {
    const lines = cart.items.length + (change.addLine ? 1 : 0);
    const units = cart.items.reduce((s, i) => s + i.quantity, 0) + change.unitDelta;
    if (lines > CART_LIMITS.lines || units > CART_LIMITS.units) {
      throw new AppError('CART_LIMIT_EXCEEDED', {
        message: `A cart can hold ${CART_LIMITS.lines} different dishes and ${CART_LIMITS.units} items in total.`,
      });
    }
  }

  /** API-CART-002 */
  async addItem(userId: string, body: AddCartItemBody): Promise<void> {
    const branch = await this.listedBranch(body.branchId);
    const resolved = await this.resolveOrThrow(branch, body);
    await this.prisma.$transaction(async (tx) => {
      let cart = await this.ensureCart(tx, userId);
      if (cart.branchId && cart.branchId !== branch.id && cart.items.length > 0) {
        if (!body.replaceCart) {
          const other = await tx.branch.findUnique({
            where: { id: cart.branchId },
            select: { restaurant: { select: { brandName: true } } },
          });
          throw new AppError('CART_BRANCH_CONFLICT', {
            message: `Your cart has items from ${other?.restaurant.brandName ?? 'another restaurant'}. Start a new cart?`,
            details: [{ code: 'EXISTING_RESTAURANT', message: other?.restaurant.brandName ?? '' }],
          });
        }
        // BR-CART-001: the customer chose to discard the other restaurant's cart.
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        cart = { ...cart, items: [] };
        await tx.cart.update({ where: { id: cart.id }, data: { coupon: { disconnect: true } } });
      }
      const hash = configHash(body);
      const same = cart.items.find((i) => i.configHash === hash);
      if (same) {
        if (same.quantity + body.quantity > CART_LIMITS.perLine) {
          throw new AppError('CART_LIMIT_EXCEEDED', {
            message: `You can add up to ${CART_LIMITS.perLine} of the same dish.`,
          });
        }
        this.assertLimits(cart, { addLine: false, unitDelta: body.quantity });
        await tx.cartItem.update({
          where: { id: same.id },
          data: { quantity: { increment: body.quantity }, unitAmountSeen: resolved.unitAmount },
        });
      } else {
        this.assertLimits(cart, { addLine: true, unitDelta: body.quantity });
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            foodItemId: body.foodItemId,
            variantId: body.variantId ?? null,
            quantity: body.quantity,
            instructions: body.instructions || null,
            configHash: hash,
            unitAmountSeen: resolved.unitAmount,
            options: { create: [...new Set(body.optionIds)].map((optionId) => ({ optionId })) },
          },
        });
      }
      await this.touch(tx, cart.id, { branch: { connect: { id: branch.id } } });
    });
  }

  private async lineOf(userId: string, lineId: string, tx: Tx) {
    const cart = await this.active(userId, tx);
    const line = cart?.items.find((i) => i.id === lineId);
    if (!cart || !line)
      throw new AppError('NOT_FOUND', { message: 'That item is no longer in your cart.' });
    return { cart, line };
  }

  /** Clears the branch and coupon once the last line goes (FR-CART-005). */
  private async afterRemoval(tx: Tx, cartId: string) {
    const left = await tx.cartItem.count({ where: { cartId } });
    await this.touch(
      tx,
      cartId,
      left === 0 ? { branch: { disconnect: true }, coupon: { disconnect: true } } : {},
    );
  }

  /** API-CART-003 */
  async updateQuantity(
    userId: string,
    lineId: string,
    quantity: number,
    version?: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { cart, line } = await this.lineOf(userId, lineId, tx);
      this.assertVersion(cart, version);
      if (quantity === 0) {
        await tx.cartItem.delete({ where: { id: line.id } });
        await this.afterRemoval(tx, cart.id);
        return;
      }
      this.assertLimits(cart, { addLine: false, unitDelta: quantity - line.quantity });
      await tx.cartItem.update({ where: { id: line.id }, data: { quantity } });
      await this.touch(tx, cart.id);
    });
  }

  /** API-CART-004: revalidate fully; merge into an identical line if one exists. */
  async replaceLine(userId: string, lineId: string, body: ReplaceCartLineBody): Promise<void> {
    const peek = await this.active(userId);
    const current = peek?.items.find((i) => i.id === lineId);
    if (!peek?.branchId || !current)
      throw new AppError('NOT_FOUND', { message: 'That item is no longer in your cart.' });
    const branch = await this.listedBranch(peek.branchId);
    const quantity = body.quantity ?? current.quantity;
    const req = {
      foodItemId: current.foodItemId,
      variantId: body.variantId,
      optionIds: body.optionIds,
      instructions: body.instructions,
      quantity,
    };
    const resolved = await this.resolveOrThrow(branch, req);
    await this.prisma.$transaction(async (tx) => {
      const { cart, line } = await this.lineOf(userId, lineId, tx);
      this.assertVersion(cart, body.version);
      const hash = configHash(req);
      const twin = cart.items.find((i) => i.configHash === hash && i.id !== line.id);
      if (twin) {
        if (twin.quantity + quantity > CART_LIMITS.perLine) {
          throw new AppError('CART_LIMIT_EXCEEDED', {
            message: `You can add up to ${CART_LIMITS.perLine} of the same dish.`,
          });
        }
        await tx.cartItem.update({
          where: { id: twin.id },
          data: { quantity: { increment: quantity }, unitAmountSeen: resolved.unitAmount },
        });
        await tx.cartItem.delete({ where: { id: line.id } });
      } else {
        this.assertLimits(cart, { addLine: false, unitDelta: quantity - line.quantity });
        await tx.cartItemOption.deleteMany({ where: { cartItemId: line.id } });
        await tx.cartItem.update({
          where: { id: line.id },
          data: {
            variantId: body.variantId ?? null,
            instructions: body.instructions || null,
            quantity,
            configHash: hash,
            unitAmountSeen: resolved.unitAmount,
            options: { create: [...new Set(body.optionIds)].map((optionId) => ({ optionId })) },
          },
        });
      }
      await this.touch(tx, cart.id);
    });
  }

  /** API-CART-005 */
  async removeLine(userId: string, lineId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { cart, line } = await this.lineOf(userId, lineId, tx);
      await tx.cartItem.delete({ where: { id: line.id } });
      await this.afterRemoval(tx, cart.id);
    });
  }

  /** API-CART-006: lines and coupon go; instructions stay. */
  async clear(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const cart = await this.active(userId, tx);
      if (!cart) return;
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await this.touch(tx, cart.id, { branch: { disconnect: true }, coupon: { disconnect: true } });
    });
  }

  /** API-CART-007 */
  async patch(
    userId: string,
    body: { instructions?: string | null; noCutlery?: boolean },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const cart = await this.ensureCart(tx, userId);
      await this.touch(tx, cart.id, {
        ...(body.instructions !== undefined ? { instructions: body.instructions || null } : {}),
        ...(body.noCutlery !== undefined ? { noCutlery: body.noCutlery } : {}),
      });
    });
  }

  /** Attaches or detaches the coupon (validated by the offers module before calling). */
  async setCoupon(userId: string, couponId: string | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const cart = await this.active(userId, tx);
      if (!cart) throw new AppError('CART_EMPTY');
      await this.touch(tx, cart.id, {
        coupon: couponId ? { connect: { id: couponId } } : { disconnect: true },
      });
    });
  }

  /**
   * API-CART-012 / FR-CART-011: adopt a guest draft when there is no server
   * cart or it is for the same branch; otherwise report the conflict unless
   * the customer chose to replace it. Lines that fail validation are returned.
   */
  async merge(userId: string, body: MergeCartBody) {
    const existing = await this.active(userId);
    if (
      existing?.branchId &&
      existing.branchId !== body.branchId &&
      existing.items.length > 0 &&
      !body.replaceCart
    ) {
      const other = await this.prisma.branch.findUnique({
        where: { id: existing.branchId },
        select: { restaurant: { select: { brandName: true } } },
      });
      throw new AppError('CART_BRANCH_CONFLICT', {
        message: `Your cart has items from ${other?.restaurant.brandName ?? 'another restaurant'}. Keep it or replace it?`,
        details: [{ code: 'EXISTING_RESTAURANT', message: other?.restaurant.brandName ?? '' }],
      });
    }
    const rejected: { index: number; code: string; message: string }[] = [];
    let first = true;
    for (const [index, line] of body.lines.entries()) {
      try {
        await this.addItem(userId, {
          ...line,
          branchId: body.branchId,
          replaceCart: first && body.replaceCart,
        });
        first = false;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        rejected.push({ index, code: error.code, message: error.message });
      }
    }
    return { rejected };
  }

  /**
   * Revalidates the whole cart (BR-CART-005) and prices it (FR-CART-008).
   * Used by GET /cart, the preview, validation and checkout.
   */
  async evaluate(
    userId: string,
    opts: {
      point?: LatLng | null;
      tipAmount?: number;
      paymentMethod?: 'ONLINE' | 'COD' | 'WALLET' | null;
      wallet?: { use: boolean; balance: number };
    } = {},
  ): Promise<Evaluated | null> {
    const cart = await this.active(userId);
    if (!cart) return null;
    if (!cart.branchId || cart.items.length === 0)
      return { cart, branch: null, view: EMPTY(cart), priced: [] };
    const now = this.clock.now();
    const branch = await this.branches.loadOne(cart.branchId, now);
    const blocking: Issue[] = [];
    const warnings: Issue[] = [];
    if (!branch || !isListed(branch)) {
      blocking.push({
        code: 'BRANCH_NOT_ACCEPTING_ORDERS',
        message: 'This restaurant is no longer available.',
      });
      return { cart, branch: null, view: { ...EMPTY(cart), blocking, lines: [] }, priced: [] };
    }
    if (!branch.computed.acceptingOrders) {
      const reopens = branch.computed.opensAt
        ? ` It opens at ${branch.computed.opensAt.toISOString()}.`
        : '';
      blocking.push({
        code: 'BRANCH_NOT_ACCEPTING_ORDERS',
        message: `${branch.restaurant.brandName} isn't taking orders right now.${reopens}`,
      });
    }
    const menu = await this.menus.raw(branch);
    const missingNames = new Map(
      (
        await this.prisma.foodItem.findMany({
          where: {
            id: {
              in: cart.items
                .filter((i) => !menu.items.some((m) => m.id === i.foodItemId))
                .map((i) => i.foodItemId),
            },
          },
          select: { id: true, name: true },
        })
      ).map((f) => [f.id, f.name]),
    );

    const lines: CartLineView[] = [];
    const priced: Evaluated['priced'] = [];
    for (const row of cart.items) {
      const result = resolveLine(
        menu,
        {
          foodItemId: row.foodItemId,
          variantId: row.variantId ?? undefined,
          optionIds: row.options.map((o) => o.optionId),
          quantity: row.quantity,
          instructions: row.instructions ?? undefined,
        },
        now,
      );
      if (result.ok) {
        const changed = row.unitAmountSeen !== null && row.unitAmountSeen !== result.unitAmount;
        lines.push({
          id: row.id,
          foodItemId: row.foodItemId,
          name: result.name,
          dietaryMarker: result.dietaryMarker,
          variant: result.variant,
          options: result.options.map((o) => ({ id: o.id, name: o.name, groupName: o.groupName })),
          quantity: row.quantity,
          instructions: row.instructions,
          unitAmount: result.unitAmount,
          lineAmount: result.unitAmount * row.quantity,
          status: changed ? 'PRICE_CHANGED' : 'OK',
          previousUnitAmount: changed ? row.unitAmountSeen : null,
          message: changed
            ? `Price changed from ₹${(row.unitAmountSeen! / 100).toFixed(2)} to ₹${(result.unitAmount / 100).toFixed(2)}.`
            : null,
        });
        if (changed)
          warnings.push({
            code: 'PRICE_CHANGED',
            lineId: row.id,
            message: `${result.name}: price changed.`,
          });
        priced.push({ lineId: row.id, quantity: row.quantity, resolved: result });
      } else {
        const status: LineStatus =
          result.code === 'ITEM_NOT_IN_BRANCH' ? 'ITEM_REMOVED' : result.code;
        lines.push({
          id: row.id,
          foodItemId: row.foodItemId,
          name: result.item?.name ?? missingNames.get(row.foodItemId) ?? 'Unavailable dish',
          dietaryMarker: result.item?.dietaryMarker ?? null,
          variant: null,
          options: [],
          quantity: row.quantity,
          instructions: row.instructions,
          unitAmount: null,
          lineAmount: null,
          status,
          previousUnitAmount: null,
          message: result.message,
        });
        blocking.push({
          code: status === 'ITEM_REMOVED' ? 'ITEM_UNAVAILABLE' : status,
          lineId: row.id,
          message: result.message,
          details: result.details,
        });
      }
    }

    const itemsSubtotal = priced.reduce((s, l) => s + l.resolved.unitAmount * l.quantity, 0);
    const offerCtx = {
      userId,
      branch,
      itemsSubtotal,
      foodItemIds: priced.map((l) => l.resolved.item.id),
      paymentMethod: opts.paymentMethod ?? null,
    };
    let couponIssue: CouponIssue | null = null;
    let coupon = null;
    let couponView: CartView['coupon'] = null;
    if (cart.couponId) {
      const result = await this.offers.coupon(cart.couponId, offerCtx);
      couponIssue = result.issue;
      coupon = result.coupon;
      if (result.coupon) couponView = { id: result.coupon.id, code: result.coupon.code };
      else if (result.issue) {
        const row = await this.prisma.coupon.findUnique({
          where: { id: cart.couponId },
          select: { code: true },
        });
        couponView = { id: cart.couponId, code: row?.code ?? '' };
      }
    }
    if (couponIssue) blocking.push({ code: couponIssue.code, message: couponIssue.message });

    const { quote, delivery } = await this.quotes.build({
      branch,
      lines: priced,
      point: opts.point ?? null,
      tipAmount: opts.tipAmount ?? 0,
      promotions: await this.offers.promotions(offerCtx),
      coupon,
      wallet: opts.wallet ?? { use: false, balance: 0 },
    });
    if (quote.couponNotice)
      warnings.push({ code: 'COUPON_NOT_COMBINED', message: quote.couponNotice });

    // FR-PRICE-003/004 (BR-PRICE-010/011)
    if (priced.length > 0 && quote.itemsSubtotal < branch.minOrderAmount) {
      blocking.push({
        code: 'ORDER_BELOW_MINIMUM',
        message: `Add ₹${((branch.minOrderAmount - quote.itemsSubtotal) / 100).toFixed(2)} more to reach the ₹${(branch.minOrderAmount / 100).toFixed(0)} minimum.`,
      });
    }
    const cap = Math.min(
      branch.maxOrderAmount ?? Number.MAX_SAFE_INTEGER,
      await this.settings.get('order.maxOrderAmount'),
    );
    if (quote.total > cap)
      blocking.push({
        code: 'ORDER_ABOVE_MAXIMUM',
        message: `Orders can be at most ₹${(cap / 100).toFixed(0)}.`,
      });
    if (
      delivery &&
      !delivery.serviceable &&
      (delivery.reason === 'OUTSIDE_ZONE' ||
        delivery.reason === 'OUTSIDE_RADIUS' ||
        delivery.reason === 'ZONE_SUSPENDED')
    ) {
      blocking.push({
        code: 'ADDRESS_NOT_SERVICEABLE',
        message: `${branch.restaurant.brandName} doesn't deliver to this location.`,
      });
    }

    return {
      cart,
      branch,
      priced,
      view: {
        id: cart.id,
        version: cart.version,
        branch: {
          id: branch.id,
          restaurantId: branch.restaurantId,
          restaurantName: branch.restaurant.brandName,
          branchName: branch.name,
          acceptingOrders: branch.computed.acceptingOrders,
          minOrderAmount: branch.minOrderAmount,
        },
        lines,
        itemCount: cart.items.reduce((s, i) => s + i.quantity, 0),
        instructions: cart.instructions,
        noCutlery: cart.noCutlery,
        coupon: couponView,
        preview: quote,
        delivery: delivery
          ? {
              serviceable: delivery.serviceable,
              reason: delivery.reason,
              distanceKm: delivery.distanceKm,
              eta: delivery.eta,
            }
          : null,
        blocking,
        warnings,
      },
    };
  }

  async view(userId: string, opts: Parameters<CartService['evaluate']>[1] = {}): Promise<CartView> {
    return (await this.evaluate(userId, opts))?.view ?? EMPTY(null);
  }

  /** The customer saw the current prices (e.g. at checkout): stop flagging them. */
  async acknowledgePrices(
    cartId: string,
    lines: { lineId: string; unitAmount: number }[],
  ): Promise<void> {
    await this.prisma.$transaction(
      lines.map((l) =>
        this.prisma.cartItem.update({
          where: { id: l.lineId },
          data: { unitAmountSeen: l.unitAmount },
        }),
      ),
    );
  }
}
