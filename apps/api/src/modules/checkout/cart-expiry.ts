import type { PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';

const DEFAULT_DAYS = 7; // BR-CART-002

/** JOB-CART-001: carts idle for `cart.expiryDays` become EXPIRED (FR-CART-012). */
export class CartExpiry {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<number> {
    const setting = await this.prisma.platformSetting.findUnique({
      where: { key: 'cart.expiryDays' },
    });
    const days =
      Number.isInteger(setting?.value) && (setting!.value as number) > 0
        ? (setting!.value as number)
        : DEFAULT_DAYS;
    const cutoff = new Date(this.clock.now().getTime() - days * 86_400_000);
    const { count } = await this.prisma.cart.updateMany({
      where: { status: 'ACTIVE', lastActivityAt: { lt: cutoff } },
      data: { status: 'EXPIRED' },
    });
    return count;
  }

  /** JOB-CHK-001: checkout sessions past their TTL (nothing is reserved until confirm). */
  async expireSessions(): Promise<number> {
    const { count } = await this.prisma.checkoutSession.updateMany({
      where: { status: 'OPEN', expiresAt: { lt: this.clock.now() } },
      data: { status: 'EXPIRED' },
    });
    return count;
  }
}
