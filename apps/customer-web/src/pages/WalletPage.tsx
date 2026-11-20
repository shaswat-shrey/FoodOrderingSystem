import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, EmptyState, ErrorState, Spinner, cn } from '@fos/ui';
import { LoadMore, PageTitle } from '../components/account-ui';
import { Section } from '../components/ui';
import { customer } from '../lib/customer';
import { day, dayTime, rupees } from '../lib/format';

const SOURCE: Record<string, string> = {
  PROMO: 'Promotional credit',
  GOODWILL: 'Goodwill credit',
  REFUND: 'Refund',
};

/** Wallet balance, expiring credits and history (API-WAL-001/002, FR-CPAY-005). */
export function WalletPage() {
  const summary = useQuery({ queryKey: ['wallet'], queryFn: () => customer.wallet.summary() });
  const txns = useInfiniteQuery({
    queryKey: ['wallet', 'transactions'],
    queryFn: ({ pageParam }) => customer.wallet.transactions(pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = txns.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="space-y-4">
      <PageTitle>Wallet</PageTitle>
      <section
        aria-label="Wallet balance"
        className="rounded-xl bg-brand-700 p-5 text-white shadow-sm"
      >
        {summary.isPending ? (
          <Spinner label="Loading balance" />
        ) : summary.isError ? (
          <p className="text-sm">Couldn’t load your balance. {summary.error.message}</p>
        ) : (
          <>
            <p className="text-sm opacity-90">Available balance</p>
            <p className="text-3xl font-bold tabular-nums">
              {rupees(summary.data.availableAmount)}
            </p>
            {summary.data.heldAmount > 0 && (
              <p className="mt-1 text-sm opacity-90">
                {rupees(summary.data.heldAmount)} on hold for an order in progress
              </p>
            )}
          </>
        )}
      </section>
      {summary.data && summary.data.expiringCredits.length > 0 && (
        <Section title="Expiring soon">
          <ul className="space-y-1 text-sm">
            {summary.data.expiringCredits.map((c, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>
                  {SOURCE[c.source] ?? 'Credit'} · expires {day(c.expiresAt)}
                </span>
                <span className="tabular-nums">{rupees(c.amount)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Transactions">
        {txns.isPending ? (
          <Spinner label="Loading transactions" />
        ) : txns.isError ? (
          <ErrorState
            title="Couldn’t load transactions"
            description={txns.error.message}
            action={<Button onClick={() => void txns.refetch()}>Try again</Button>}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            description="Refunds and credits to your wallet show up here."
          />
        ) : (
          <ul className="divide-y divide-gray-100" aria-label="Wallet transactions">
            {rows.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="block text-gray-900">{t.description}</span>
                  <span className="text-xs text-gray-500">{dayTime(t.createdAt)}</span>
                </span>
                <span
                  className={cn(
                    'shrink-0 font-semibold tabular-nums',
                    t.amount > 0 ? 'text-success-600' : 'text-gray-900',
                  )}
                >
                  {t.amount > 0 ? '+' : '−'}
                  {rupees(Math.abs(t.amount))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <LoadMore
          hasMore={Boolean(txns.hasNextPage)}
          loading={txns.isFetchingNextPage}
          onClick={() => void txns.fetchNextPage()}
        />
      </Section>
    </div>
  );
}
