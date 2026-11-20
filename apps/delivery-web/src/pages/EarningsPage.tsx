import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { NextPayout } from '@fos/api-client';
import { Button, cn, Spinner } from '@fos/ui';
import { Section, ServerError, Stat } from '../components/ui';
import { day, percent, rupees } from '../lib/format';
import { partner } from '../lib/partner';

const PERIODS = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
] as const;

const PAYOUT_NOTE: Record<NextPayout['status'], string> = {
  SCHEDULED: 'Paid on Monday for this week.',
  BELOW_MINIMUM: 'Below the minimum payout; it rolls over to next week.',
  CARRY_OVER_NEGATIVE: 'You hold more cash than you earned; deposit cash or it carries over.',
  ON_HOLD_BANK_CHANGE: 'On hold until your new bank account is verified.',
};

/** FR-EARN-002/005/006/007: earnings, cash, payouts and performance. */
export function EarningsPage() {
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');
  const summary = useQuery({
    queryKey: ['partner', 'earnings', period],
    queryFn: () => partner.earnings.summary(period),
  });
  const cash = useQuery({ queryKey: ['partner', 'cash'], queryFn: partner.earnings.cash });
  const payouts = useQuery({ queryKey: ['partner', 'payouts'], queryFn: partner.earnings.payouts });
  const perf = useQuery({
    queryKey: ['partner', 'performance'],
    queryFn: partner.earnings.performance,
  });
  const ratings = useQuery({ queryKey: ['partner', 'ratings'], queryFn: partner.earnings.ratings });
  const s = summary.data;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Earnings</h1>
      <div
        role="tablist"
        aria-label="Period"
        className="grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1"
      >
        {PERIODS.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={period === p.id}
            onClick={() => setPeriod(p.id)}
            className={cn(
              'h-10 rounded-md text-sm font-medium',
              period === p.id ? 'bg-white text-gray-900 shadow' : 'text-gray-600',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <Section
        title="Total"
        aside={s && <span className="text-2xl font-bold">{rupees(s.total)}</span>}
      >
        {summary.isPending && <Spinner />}
        <ServerError error={summary.error} />
        {s && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Deliveries" value={s.deliveries} />
              <Stat label="Distance" value={`${s.distanceKm} km`} />
              <Stat label="Tips" value={rupees(s.breakdown.tips)} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-gray-600">Base pay</dt>
              <dd className="text-right">{rupees(s.breakdown.base)}</dd>
              <dt className="text-gray-600">Distance pay</dt>
              <dd className="text-right">{rupees(s.breakdown.distance)}</dd>
              <dt className="text-gray-600">Waiting pay</dt>
              <dd className="text-right">{rupees(s.breakdown.wait)}</dd>
              <dt className="text-gray-600">Surge and rain</dt>
              <dd className="text-right">{rupees(s.breakdown.surge)}</dd>
              <dt className="text-gray-600">Incentives</dt>
              <dd className="text-right">{rupees(s.breakdown.incentives)}</dd>
              <dt className="text-gray-600">Adjustments</dt>
              <dd className="text-right">{rupees(s.breakdown.adjustments)}</dd>
            </dl>
            {s.cancelledTrips > 0 && (
              <p className="mt-2 text-xs text-gray-500">
                Includes pay for {s.cancelledTrips} cancelled trip(s).
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Cash in hand">
        {cash.data && (
          <>
            <p className="text-2xl font-bold text-gray-900">{rupees(cash.data.balance)}</p>
            <p className="text-sm text-gray-600">
              Limit {rupees(cash.data.cap)} · {rupees(cash.data.remaining)} left
            </p>
            {cash.data.blocked && (
              <p className="mt-1 text-sm text-warning-600">
                You won’t get cash orders until you deposit.
              </p>
            )}
            <p className="mt-2 text-xs text-gray-500">{cash.data.howToDeposit}</p>
          </>
        )}
      </Section>

      <Section title="Next payout">
        {payouts.data && (
          <>
            <p className="text-2xl font-bold text-gray-900">
              {rupees(Math.max(0, payouts.data.next.amount))}
            </p>
            <p className="text-sm text-gray-600">
              Earnings {rupees(payouts.data.next.earnings)} − cash{' '}
              {rupees(payouts.data.next.cashDeduction)}
            </p>
            <p className="mt-1 text-sm text-gray-700">{PAYOUT_NOTE[payouts.data.next.status]}</p>
            {payouts.data.items.length > 0 && (
              <ul className="mt-3 divide-y divide-gray-100 text-sm">
                {payouts.data.items.map((p) => (
                  <li key={p.id} className="flex justify-between py-2">
                    <span>
                      {day(p.periodStart)} – {day(p.periodEnd)}
                    </span>
                    <span>
                      {rupees(p.amount)} ·{' '}
                      {p.status === 'PAID' ? `UTR ${p.utr}` : p.status.toLowerCase()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section title="Last 30 days">
        {perf.data && (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Acceptance" value={percent(perf.data.acceptanceRate)} />
            <Stat label="Completion" value={percent(perf.data.completionRate)} />
            <Stat label="On time" value={percent(perf.data.onTimeRate)} />
            <Stat
              label="Rating"
              value={ratings.data?.average != null ? `${ratings.data.average.toFixed(1)} ★` : 'New'}
            />
          </div>
        )}
        {ratings.data && Object.keys(ratings.data.tags).length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(ratings.data.tags).map(([tag, n]) => (
              <li key={tag} className="rounded-full bg-gray-100 px-2 py-1">
                {tag.replaceAll('_', ' ').toLowerCase()} · {n}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Statement />
    </div>
  );
}

function Statement() {
  const entries = useInfiniteQuery({
    queryKey: ['partner', 'statement'],
    queryFn: ({ pageParam }) =>
      partner.earnings.entries(pageParam ? { cursor: pageParam, limit: 20 } : { limit: 20 }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = entries.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Section title="Statement">
      {rows.length === 0 && !entries.isPending && (
        <p className="text-sm text-gray-600">Nothing yet.</p>
      )}
      <ul className="divide-y divide-gray-100 text-sm">
        {rows.map((e) => (
          <li key={e.id} className="flex justify-between gap-2 py-2">
            <span>
              <span className="block text-gray-900">
                {e.type === 'TIP' ? 'Tip' : e.description}
              </span>
              <span className="text-xs text-gray-500">{day(e.createdAt)}</span>
            </span>
            <span className={e.amount < 0 ? 'text-danger-600' : 'text-gray-900'}>
              {rupees(e.amount)}
            </span>
          </li>
        ))}
      </ul>
      {entries.hasNextPage && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          loading={entries.isFetchingNextPage}
          onClick={() => entries.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </Section>
  );
}
