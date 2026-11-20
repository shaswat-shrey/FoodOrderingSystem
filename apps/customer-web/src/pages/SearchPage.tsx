import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { DietaryMarker, EmptyState, ErrorState, Spinner, cn } from '@fos/ui';
import { RestaurantCard } from '../components/RestaurantCard';
import { customer } from '../lib/customer';
import { etaRange, rupees } from '../lib/format';
import { useDeliveryLocation } from '../lib/location';

type Tab = 'restaurant' | 'dish';

/** Search restaurants and dishes as you type (FR-SRCH-001, debounced). */
export function SearchPage() {
  const location = useDeliveryLocation();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [q, setQ] = useState(text.trim());
  const [tab, setTab] = useState<Tab>('restaurant');

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(text.trim());
      setParams(text.trim() ? { q: text.trim() } : {}, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [text, setParams]);

  const point = location ? { lat: location.lat, lng: location.lng } : null;
  const results = useQuery({
    queryKey: ['search', q, point],
    queryFn: () => customer.search.query({ q, ...point!, type: 'all', limit: 20 }),
    enabled: Boolean(point) && q.length >= 2,
  });

  if (!location) {
    return (
      <EmptyState
        title="Set your delivery location first"
        description="Search shows places that deliver to you."
        action={
          <Link to="/location?next=/search" className="font-medium text-brand-700 underline">
            Choose location
          </Link>
        }
      />
    );
  }

  const data = results.data?.data;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-900">Search</h1>
      <div role="search">
        <label htmlFor="search-input" className="sr-only">
          Search restaurants and dishes
        </label>
        <input
          id="search-input"
          type="search"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search restaurants and dishes"
          className="block h-12 w-full rounded-xl border border-gray-300 bg-white px-4 text-base focus:border-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
      </div>

      {q.length < 2 ? (
        <p className="text-sm text-gray-600">Type at least 2 characters.</p>
      ) : results.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner label="Searching" />
        </div>
      ) : results.isError ? (
        <ErrorState title="Search failed" description={results.error.message} />
      ) : (
        <>
          <div role="tablist" aria-label="Result type" className="flex gap-2">
            {(
              [
                ['restaurant', `Restaurants (${data?.restaurants.length ?? 0})`],
                ['dish', `Dishes (${data?.dishes.length ?? 0})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cn(
                  'h-11 rounded-full px-4 text-sm font-medium',
                  tab === key
                    ? 'bg-brand-700 text-white'
                    : 'bg-white text-gray-800 ring-1 ring-gray-300',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel" aria-live="polite">
            {tab === 'restaurant' ? (
              data && data.restaurants.length > 0 ? (
                <ul className="space-y-3">
                  {data.restaurants.map((r) => (
                    <RestaurantCard key={r.branchId} card={r} />
                  ))}
                </ul>
              ) : (
                <EmptyState title={`No restaurants for “${q}”`} />
              )
            ) : data && data.dishes.length > 0 ? (
              <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
                {data.dishes.map((d) => (
                  <li key={`${d.branch.branchId}:${d.item.id}`}>
                    <Link
                      to={`/restaurants/${d.branch.branchId}#item-${d.item.id}`}
                      className="flex items-start gap-2 p-3 hover:bg-gray-50"
                    >
                      <DietaryMarker type={d.item.dietaryMarker} className="mt-1" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-gray-900">{d.item.name}</span>
                        <span className="block text-sm text-gray-600">
                          {d.branch.restaurantName} · {etaRange(d.branch.eta)}
                        </span>
                      </span>
                      <span className="font-medium tabular-nums">{rupees(d.item.priceAmount)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={`No dishes for “${q}”`} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
