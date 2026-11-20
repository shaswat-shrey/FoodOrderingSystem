import { Link } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { RestaurantPayout } from '@fos/api-client';
import { Alert, Button, EmptyState, Spinner } from '@fos/ui';
import { Section, ServerError } from '../components/fields';
import { day, label, rupees } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

const TONE: Record<RestaurantPayout['status'], string> = {
  PAID: 'bg-green-100 text-green-800',
  PENDING: 'bg-amber-100 text-amber-800',
  FAILED: 'bg-red-100 text-red-800',
};

/** FR-RFIN-002/003: payout history, where payouts go, and bank change requests. */
export function PayoutsPage() {
  const { restaurant, can } = useWorkspace();
  const rid = restaurant?.id ?? '';
  const allowed = can('rest.finance:read');
  const payouts = useInfiniteQuery({
    queryKey: ['payouts', rid],
    queryFn: ({ pageParam }) =>
      merchant.restaurant.payouts(rid, { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(rid && allowed),
  });
  const profile = useQuery({
    queryKey: ['restaurant', rid, 'profile'],
    queryFn: () => merchant.restaurant.get(rid),
    enabled: Boolean(rid && allowed && can('rest.restaurant:read')),
  });
  const requests = useQuery({
    queryKey: ['restaurant', rid, 'change-requests'],
    queryFn: () => merchant.restaurant.changeRequests(rid),
    enabled: Boolean(rid && allowed && can('rest.restaurant:read')),
  });
  if (!restaurant) return null;
  if (!allowed) return <EmptyState title="Only owners and finance staff can see payouts" />;
  const list = payouts.data?.pages.flatMap((p) => p.data) ?? [];
  const bank = profile.data?.bank;
  const bankChanges = (requests.data ?? []).filter((r) => r.type === 'BANK_ACCOUNT');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Payouts</h1>
      <Section title="Payouts go to">
        {bank ? (
          <p className="text-sm">
            {bank.holderName} · {bank.accountMasked} · {bank.ifsc}{' '}
            <span className="text-gray-600">({label(bank.status)})</span>
          </p>
        ) : (
          profile.data && <p className="text-sm text-gray-600">No bank account on file.</p>
        )}
        {bankChanges.length > 0 && (
          <ul className="mt-2 text-sm" aria-label="Bank change requests">
            {bankChanges.map((r) => (
              <li key={r.id}>
                Change requested {day(r.createdAt)}: <strong>{label(r.status)}</strong>
                {r.reason && <span className="text-gray-600"> — {r.reason}</span>}
              </li>
            ))}
          </ul>
        )}
        {bankChanges.some((r) => r.status === 'PENDING') && (
          <Alert tone="warning" className="mt-2">
            A bank change is waiting for verification; payouts keep going to the verified account
            until then.
          </Alert>
        )}
        {can('rest.restaurant:legal') && (
          <p className="mt-2 text-sm">
            <Link to="/profile" className="text-brand-700 underline">
              Change bank account
            </Link>
          </p>
        )}
      </Section>

      <Section title="History">
        <ServerError error={payouts.error} />
        {payouts.isPending ? (
          <Spinner />
        ) : list.length === 0 ? (
          <p className="text-sm text-gray-600">
            No payouts yet. Payouts are made weekly for delivered orders.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Payout history</caption>
            <thead>
              <tr className="text-gray-600">
                <th scope="col" className="py-1">
                  Period
                </th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col" className="hidden md:table-cell">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="border-t border-gray-100 align-top">
                  <th scope="row" className="py-2 font-normal">
                    {day(p.periodStart)} – {day(p.periodEnd)}
                  </th>
                  <td className="py-2 font-semibold tabular-nums">{rupees(p.amount)}</td>
                  <td className="py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[p.status]}`}
                    >
                      {label(p.status)}
                    </span>
                    {p.status === 'PAID' && p.paidAt && (
                      <span className="block text-xs text-gray-600">on {day(p.paidAt)}</span>
                    )}
                    {p.failureReason && (
                      <span className="block text-xs text-danger-600">{p.failureReason}</span>
                    )}
                  </td>
                  <td className="hidden py-2 text-xs text-gray-700 md:table-cell">
                    {p.settlement && (
                      <span className="block">
                        Sales {rupees(p.settlement.gross)} − commission{' '}
                        {rupees(p.settlement.commission)} − taxes {rupees(p.settlement.taxes)}
                        {p.settlement.adjustments !== 0 &&
                          ` ± adjustments ${rupees(p.settlement.adjustments)}`}
                      </span>
                    )}
                    {p.utr && <span className="block">UTR {p.utr}</span>}
                    {p.bank && (
                      <span className="block">
                        To {p.bank.accountMasked} · {p.bank.ifsc}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {payouts.hasNextPage && (
          <Button
            className="mt-3"
            variant="secondary"
            loading={payouts.isFetchingNextPage}
            onClick={() => void payouts.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </Section>
    </div>
  );
}
