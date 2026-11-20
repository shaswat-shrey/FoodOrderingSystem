import type { CreditSource, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { decodeCursor, encodeCursor, queryFingerprint } from '../../platform/pagination';
import type { AccountRef, LedgerService } from './ledger.service';

type Tx = Prisma.TransactionClient;
const wallet = (userId: string) => ({
  ownerType: 'CUSTOMER' as const,
  ownerId: userId,
  type: 'CUSTOMER_WALLET' as const,
});
const hold = (userId: string) => ({
  ownerType: 'CUSTOMER' as const,
  ownerId: userId,
  type: 'CUSTOMER_WALLET_HOLD' as const,
});
const orderLiability = (orderId: string) => ({
  ownerType: 'ORDER' as const,
  ownerId: orderId,
  type: 'CUSTOMER_ORDER_LIABILITY' as const,
});

/** Default expiry for promotional and goodwill credits (BR-WALLET-002); refund credits never expire. */
const PROMO_EXPIRY_DAYS = 30;

/**
 * Closed-loop customer wallet (BR-WALLET-001…003, FR-PAY-012, FR-CPAY-005):
 * credits in lots, HOLD at order creation, DEBIT on payment / COD placement,
 * RELEASE when the order fails or is cancelled early.
 */
export class WalletService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly clock: Clock,
  ) {}

  async available(userId: string, db: PrismaClient | Tx = this.prisma): Promise<number> {
    return this.ledger.balance(db, wallet(userId));
  }

  /** API-WAL-001 */
  async summary(userId: string) {
    const [available, held, lots] = await Promise.all([
      this.available(userId),
      this.ledger.balance(this.prisma, hold(userId)),
      this.prisma.walletCreditLot.findMany({
        where: {
          account: { ownerType: 'CUSTOMER', ownerId: userId, type: 'CUSTOMER_WALLET' },
          remaining: { gt: 0 },
          expiresAt: { not: null, gt: this.clock.now() },
        },
        orderBy: { expiresAt: 'asc' },
        take: 10,
      }),
    ]);
    return {
      currency: 'INR',
      availableAmount: available,
      heldAmount: held,
      expiringCredits: lots.map((l) => ({
        amount: l.remaining,
        source: l.source,
        expiresAt: l.expiresAt,
      })),
    };
  }

  /** Credits the wallet (refund to wallet, promotion, goodwill) as a lot. */
  async credit(
    tx: Tx,
    input: {
      userId: string;
      amount: number;
      source: CreditSource;
      referenceType: string;
      referenceId: string;
      description: string;
      expiresAt?: Date | null;
      createdBy?: string | null;
      from?: AccountRef;
    },
  ): Promise<void> {
    if (input.amount <= 0)
      throw new AppError('VALIDATION_ERROR', { message: 'Credit must be positive.' });
    const expense =
      input.source === 'PROMO'
        ? 'PLATFORM_PROMO_EXPENSE'
        : input.source === 'GOODWILL'
          ? 'PLATFORM_REFUND_EXPENSE'
          : 'REFUND_CLEARING';
    const posted = await this.ledger.post(tx, {
      type: 'WALLET_CREDIT',
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
      createdBy: input.createdBy ?? null,
      entries: [
        // Who funds the credit: the given account (e.g. the cost bearer of a refund), else the platform.
        {
          ...(input.from ?? { ownerType: 'PLATFORM' as const, ownerId: null, type: expense }),
          amount: input.amount,
        },
        { ...wallet(input.userId), amount: -input.amount },
      ],
    });
    if (posted.duplicate) return;
    const account = await this.ledger.account(tx, wallet(input.userId));
    const expiresAt =
      input.expiresAt !== undefined
        ? input.expiresAt
        : input.source === 'REFUND'
          ? null
          : new Date(this.clock.now().getTime() + PROMO_EXPIRY_DAYS * 86_400_000);
    await tx.walletCreditLot.create({
      data: {
        accountId: account.id,
        source: input.source,
        amount: input.amount,
        remaining: input.amount,
        expiresAt,
      },
    });
  }

  /** At order creation: moves the amount to the hold account; never below zero (DB check + row lock). */
  async hold(tx: Tx, input: { userId: string; orderId: string; amount: number }): Promise<void> {
    if (input.amount === 0) return;
    if ((await this.available(input.userId, tx)) < input.amount)
      throw new AppError('INSUFFICIENT_WALLET_BALANCE');
    try {
      await this.ledger.post(tx, {
        type: 'WALLET_HOLD',
        referenceType: 'order',
        referenceId: input.orderId,
        description: 'Wallet amount held for order',
        entries: [
          { ...wallet(input.userId), amount: input.amount },
          { ...hold(input.userId), amount: -input.amount },
        ],
      });
    } catch (error) {
      if (String(error).includes('ledger_accounts_wallet_non_negative_chk'))
        throw new AppError('INSUFFICIENT_WALLET_BALANCE');
      throw error;
    }
  }

  /** On payment success / COD placement: the held amount pays the order; lots are consumed earliest-expiring first (BR-WALLET-003). */
  async debit(tx: Tx, input: { userId: string; orderId: string; amount: number }): Promise<void> {
    if (input.amount === 0) return;
    const posted = await this.ledger.post(tx, {
      type: 'WALLET_DEBIT',
      referenceType: 'order',
      referenceId: input.orderId,
      description: 'Wallet amount applied to order',
      entries: [
        { ...hold(input.userId), amount: input.amount },
        { ...orderLiability(input.orderId), amount: -input.amount },
      ],
    });
    if (posted.duplicate) return;
    await this.consumeLots(tx, input.userId, input.amount);
  }

  /** Spends credit lots, earliest-expiring first (BR-WALLET-003). */
  private async consumeLots(tx: Tx, userId: string, amount: number): Promise<void> {
    const lots = await tx.$queryRaw<{ id: string; remaining: number }[]>`
      SELECT l.id, l.remaining FROM wallet_credit_lots l
      JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.owner_type = 'CUSTOMER' AND a.owner_id = ${userId}::uuid AND a.type = 'CUSTOMER_WALLET' AND l.remaining > 0
      ORDER BY l.expires_at ASC NULLS LAST, l.created_at ASC
      FOR UPDATE OF l`;
    let left = amount;
    for (const lot of lots) {
      if (left === 0) break;
      const take = Math.min(lot.remaining, left);
      await tx.walletCreditLot.update({
        where: { id: lot.id },
        data: { remaining: { decrement: take } },
      });
      left -= take;
    }
  }

  /**
   * Admin wallet adjustment (FR-ADMIN-010, API-ADM-016): a positive amount is a
   * goodwill credit (expiring like other goodwill credit unless `expiresAt` is
   * given); a negative amount takes money back, never below zero.
   */
  async adjust(
    tx: Tx,
    input: {
      userId: string;
      amount: number;
      referenceId: string;
      description: string;
      createdBy: string;
      expiresAt?: Date | null | undefined;
    },
  ): Promise<void> {
    if (input.amount > 0) {
      await this.credit(tx, {
        userId: input.userId,
        amount: input.amount,
        source: 'GOODWILL',
        referenceType: 'wallet_adjustment',
        referenceId: input.referenceId,
        description: input.description,
        createdBy: input.createdBy,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      });
      return;
    }
    const amount = -input.amount;
    if (amount <= 0)
      throw new AppError('VALIDATION_ERROR', { message: 'Adjustment must not be zero.' });
    await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE owner_type = 'CUSTOMER' AND owner_id = ${input.userId}::uuid AND type = 'CUSTOMER_WALLET' FOR UPDATE`;
    if ((await this.available(input.userId, tx)) < amount)
      throw new AppError('INSUFFICIENT_WALLET_BALANCE', {
        message: 'The wallet holds less than this amount.',
      });
    await this.ledger.post(tx, {
      type: 'ADJUSTMENT',
      referenceType: 'wallet_adjustment',
      referenceId: input.referenceId,
      description: input.description,
      createdBy: input.createdBy,
      entries: [
        { ...wallet(input.userId), amount },
        { ownerType: 'PLATFORM', ownerId: null, type: 'PLATFORM_REFUND_EXPENSE', amount: -amount },
      ],
    });
    await this.consumeLots(tx, input.userId, amount);
  }

  /** Order failed or cancelled before payment: the hold returns to the wallet. */
  async release(tx: Tx, input: { userId: string; orderId: string; amount: number }): Promise<void> {
    if (input.amount === 0) return;
    await this.ledger.post(tx, {
      type: 'WALLET_RELEASE',
      referenceType: 'order',
      referenceId: input.orderId,
      description: 'Held wallet amount returned',
      entries: [
        { ...hold(input.userId), amount: input.amount },
        { ...wallet(input.userId), amount: -input.amount },
      ],
    });
  }

  /** API-WAL-002: wallet movements, newest first (amount > 0 = money into the wallet). */
  async transactions(userId: string, opts: { limit: number; cursor?: string | undefined }) {
    const context = queryFingerprint(['wallet', userId]);
    const after = opts.cursor ? decodeCursor(opts.cursor, context) : null;
    const account = await this.prisma.ledgerAccount.findFirst({
      where: { ownerType: 'CUSTOMER', ownerId: userId, type: 'CUSTOMER_WALLET' },
      select: { id: true },
    });
    if (!account) return { items: [], nextCursor: null };
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        accountId: account.id,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after[0] as number) } },
                { createdAt: new Date(after[0] as number), id: { lt: after[1] as string } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      include: {
        transaction: {
          select: { type: true, description: true, referenceType: true, referenceId: true },
        },
      },
    });
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      items: page.map((e) => ({
        id: e.id,
        type: e.transaction.type,
        description: e.transaction.description,
        amount: -Number(e.amount),
        reference: { type: e.transaction.referenceType, id: e.transaction.referenceId },
        createdAt: e.createdAt,
      })),
      nextCursor:
        rows.length > opts.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }
}
