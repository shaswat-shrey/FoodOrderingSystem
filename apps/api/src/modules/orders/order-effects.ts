import type { Order, Prisma } from '@fos/db';
import type { WalletService } from '../ledger';
import type { OffersService } from '../offers';

type Tx = Prisma.TransactionClient;

/** Stock is restored only for orders that ended before the kitchen started (BR-MENU-006). */
const BEFORE_KITCHEN = new Set(['PAYMENT_PENDING', 'PLACED', 'ACCEPTED']);

/**
 * Reservations an order holds and how to give them back: coupon (BR-COUPON-006),
 * wallet hold (FR-PAY-012) and tracked stock (BR-MENU-006).
 */
export class OrderEffects {
  constructor(
    private readonly offers: OffersService,
    private readonly wallet: WalletService,
  ) {}

  /** Whether the wallet hold for the order was already consumed (DEBIT posted). */
  async walletDebited(tx: Tx, orderId: string): Promise<boolean> {
    return (
      (await tx.ledgerTransaction.count({
        where: { type: 'WALLET_DEBIT', referenceType: 'order', referenceId: orderId },
      })) > 0
    );
  }

  /** Payment confirmed (T03): coupon becomes REDEEMED, held wallet credit pays the order. */
  async consume(tx: Tx, order: Order): Promise<void> {
    await this.offers.redeem(tx, order.id);
    if (order.walletAppliedAmount > 0 && !(await this.walletDebited(tx, order.id))) {
      await this.wallet.debit(tx, {
        userId: order.userId,
        orderId: order.id,
        amount: order.walletAppliedAmount,
      });
    }
  }

  /**
   * The order ended without being fulfilled. `previousStatus` is the status it
   * left. Returns whether the wallet hold was returned (so callers know whether
   * the wallet part still needs a refund).
   */
  async release(
    tx: Tx,
    order: Order,
    previousStatus: string,
    opts: { restoreCoupon: boolean },
  ): Promise<{ walletReleased: boolean }> {
    if (opts.restoreCoupon) await this.offers.release(tx, order.id);
    let walletReleased = false;
    if (order.walletAppliedAmount > 0 && !(await this.walletDebited(tx, order.id))) {
      await this.wallet.release(tx, {
        userId: order.userId,
        orderId: order.id,
        amount: order.walletAppliedAmount,
      });
      walletReleased = true;
    }
    if (BEFORE_KITCHEN.has(previousStatus)) await this.restoreStock(tx, order);
    return { walletReleased };
  }

  private async restoreStock(tx: Tx, order: Order): Promise<void> {
    const items = await tx.orderItem.findMany({
      where: { orderId: order.id },
      select: { foodItemId: true, quantity: true },
    });
    let changed = false;
    for (const item of items) {
      const res = await tx.branchItemStock.updateMany({
        where: { branchId: order.branchId, foodItemId: item.foodItemId },
        data: { quantity: { increment: item.quantity }, version: { increment: 1 } },
      });
      if (res.count > 0) changed = true;
    }
    if (changed)
      await tx.branch.update({
        where: { id: order.branchId },
        data: { menuVersion: { increment: 1 } },
      });
  }
}
