import type { PrismaClient } from '@fos/db';
import { AppError } from '../../platform/http/errors';
import type { CartService } from '../checkout';

/** API-ORD-008 (FR-CORD-008, BR-ORDER-018): a new cart from a past order at current prices. */
export class ReorderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cart: CartService,
  ) {}

  async reorder(userId: string, orderId: string, opts: { replaceCart: boolean }) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { items: { include: { options: true }, orderBy: { id: 'asc' } } },
    });
    if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    const added: string[] = [];
    const skipped: { itemName: string; reason: string }[] = [];
    let replace = opts.replaceCart;
    for (const line of order.items) {
      const variant = line.variantName
        ? await this.prisma.foodItemVariant.findFirst({
            where: { foodItemId: line.foodItemId, name: line.variantName },
            select: { id: true },
          })
        : null;
      if (line.variantName && !variant) {
        skipped.push({ itemName: line.itemName, reason: 'VARIANT_UNAVAILABLE' });
        continue;
      }
      try {
        await this.cart.addItem(userId, {
          branchId: order.branchId,
          foodItemId: line.foodItemId,
          ...(variant ? { variantId: variant.id } : {}),
          optionIds: line.options.map((o) => o.optionId),
          ...(line.instructions ? { instructions: line.instructions } : {}),
          quantity: line.quantity,
          replaceCart: replace,
        });
        replace = false; // the cart now belongs to this branch
        added.push(line.itemName);
      } catch (error) {
        // A different restaurant's cart is the customer's decision, not a skipped line.
        if (error instanceof AppError && error.code === 'CART_BRANCH_CONFLICT') throw error;
        if (!(error instanceof AppError)) throw error;
        skipped.push({ itemName: line.itemName, reason: error.code });
      }
    }
    if (added.length === 0 && skipped.length > 0) {
      throw new AppError('ITEM_UNAVAILABLE', {
        message: 'None of the items from this order are available right now.',
        details: skipped.map((s) => ({ code: s.reason, message: s.itemName })),
      });
    }
    return { added, skipped, cart: await this.cart.view(userId) };
  }
}
