import type {
  LedgerAccountType,
  LedgerOwnerType,
  LedgerTransactionType,
  Prisma,
  PrismaClient,
} from '@fos/db';
import { uuidv7 } from '@fos/shared';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Sign convention (ADR-011): entry amounts are + debit / − credit, and every
 * transaction sums to zero (enforced by a database trigger). Account balances
 * are stored on the account's normal side, so liabilities and revenue (credit
 * normal) show positive balances — e.g. a customer wallet holding ₹50 has
 * balance 5000 after a −5000 entry. The database keeps wallets ≥ 0.
 */
const CREDIT_NORMAL = new Set<LedgerAccountType>([
  'CUSTOMER_WALLET',
  'CUSTOMER_WALLET_HOLD',
  'CUSTOMER_ORDER_LIABILITY',
  'RESTAURANT_PAYABLE',
  'PARTNER_PAYABLE',
  'PLATFORM_REVENUE_COMMISSION',
  'PLATFORM_REVENUE_FEES',
  'TAX_PAYABLE',
]);

export const normalSign = (type: LedgerAccountType) => (CREDIT_NORMAL.has(type) ? -1 : 1);

export interface AccountRef {
  ownerType: LedgerOwnerType;
  ownerId: string | null;
  type: LedgerAccountType;
}

export interface PostInput {
  type: LedgerTransactionType;
  referenceType: string;
  referenceId: string;
  /** Distinguishes several postings of one type for the same reference (e.g. two partial refunds). */
  idempotencyKey?: string;
  description: string;
  createdBy?: string | null;
  entries: (AccountRef & { amount: number })[];
}

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
}

/** Double-entry ledger (ADR-011, FR-PAY-013, FR-RECON-003). */
export class LedgerService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Finds or creates an account (unique per owner, type and currency). */
  async account(db: Db, ref: AccountRef): Promise<{ id: string; type: LedgerAccountType }> {
    const ownerId = ref.ownerId ?? null;
    await db.$executeRaw`
      INSERT INTO ledger_accounts (id, owner_type, owner_id, type, currency, updated_at)
      VALUES (${uuidv7()}::uuid, ${ref.ownerType}::"LedgerOwnerType", ${ownerId}::uuid, ${ref.type}::"LedgerAccountType", 'INR', now())
      ON CONFLICT DO NOTHING`;
    const row = await db.ledgerAccount.findFirst({
      where: { ownerType: ref.ownerType, ownerId, type: ref.type, currency: 'INR' },
      select: { id: true, type: true },
    });
    if (!row) throw new LedgerError(`ledger account missing: ${ref.ownerType}/${ref.type}`);
    return row;
  }

  /**
   * Posts a balanced transaction inside `tx`. Idempotent: posting the same
   * (type, reference, key) again is a no-op that returns the first transaction.
   * Accounts are locked in id order so concurrent postings can't deadlock.
   */
  async post(
    tx: Prisma.TransactionClient,
    input: PostInput,
  ): Promise<{ transactionId: string; duplicate: boolean }> {
    const merged = new Map<string, { ref: AccountRef; amount: number }>();
    for (const e of input.entries) {
      if (!Number.isSafeInteger(e.amount))
        throw new LedgerError('entry amounts must be integer paise');
      const k = `${e.ownerType}|${e.ownerId ?? ''}|${e.type}`;
      merged.set(k, { ref: e, amount: (merged.get(k)?.amount ?? 0) + e.amount });
    }
    const lines = [...merged.values()].filter((l) => l.amount !== 0);
    if (lines.length < 2)
      throw new LedgerError('a transaction needs at least two non-zero entries');
    if (lines.reduce((s, l) => s + l.amount, 0) !== 0)
      throw new LedgerError('entries must sum to zero');

    const id = uuidv7();
    const key = input.idempotencyKey ?? '';
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ledger_transactions (id, type, reference_type, reference_id, idempotency_key, description, created_by)
      VALUES (${id}::uuid, ${input.type}::"LedgerTransactionType", ${input.referenceType}, ${input.referenceId}::uuid, ${key},
        ${input.description.slice(0, 300)}, ${input.createdBy ?? null}::uuid)
      ON CONFLICT (type, reference_type, reference_id, idempotency_key) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) {
      const existing = await tx.ledgerTransaction.findFirstOrThrow({
        where: {
          type: input.type,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          idempotencyKey: key,
        },
        select: { id: true },
      });
      return { transactionId: existing.id, duplicate: true };
    }

    const accounts = await Promise.all(
      lines.map(async (l) => ({ ...(await this.account(tx, l.ref)), amount: l.amount })),
    );
    const ids = [...accounts.map((a) => a.id)].sort();
    await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    await tx.ledgerEntry.createMany({
      data: accounts.map((a) => ({ transactionId: id, accountId: a.id, amount: BigInt(a.amount) })),
    });
    for (const a of accounts) {
      await tx.$executeRaw`
        UPDATE ledger_accounts SET balance = balance + ${BigInt(a.amount * normalSign(a.type))}, version = version + 1, updated_at = now()
        WHERE id = ${a.id}::uuid`;
    }
    return { transactionId: id, duplicate: false };
  }

  /** Normal-side balance of an account (0 when it doesn't exist yet). */
  async balance(db: Db, ref: AccountRef): Promise<number> {
    const row = await db.ledgerAccount.findFirst({
      where: { ownerType: ref.ownerType, ownerId: ref.ownerId, type: ref.type, currency: 'INR' },
      select: { balance: true },
    });
    return Number(row?.balance ?? 0n);
  }

  /**
   * FR-RECON-003 / JOB-LEDGER-001: every cached balance equals its entries.
   * (Per-transaction balance is guaranteed by the deferred trigger.)
   */
  async verify(): Promise<{ accountId: string; type: string; stored: bigint; computed: bigint }[]> {
    const rows = await this.prisma.$queryRaw<
      { id: string; type: LedgerAccountType; balance: bigint; total: bigint | null }[]
    >`
      SELECT a.id, a.type, a.balance, (SELECT sum(e.amount)::bigint FROM ledger_entries e WHERE e.account_id = a.id) AS total
      FROM ledger_accounts a`;
    return rows
      .map((r) => ({
        accountId: r.id,
        type: r.type,
        stored: r.balance,
        computed: BigInt(normalSign(r.type)) * (r.total ?? 0n),
      }))
      .filter((r) => r.stored !== r.computed);
  }
}
