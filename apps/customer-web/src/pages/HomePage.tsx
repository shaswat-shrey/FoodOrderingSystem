import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Alert, Button, EmptyState, ErrorState, Spinner, cn } from '@fos/ui';
import { RestaurantCard } from '../components/RestaurantCard';
import { Select } from '../components/ui';
import { customer } from '../lib/customer';
import { SERVICEABILITY_TEXT } from '../lib/format';
import { useDeliveryLocation } from '../lib/location';

type Sort = NonNullable<NonNullable<Parameters<typeof customer.discovery.restaurants>[1]>['sort']>;

const SORTS: { value: Sort; label: string }[] = [
  { value: 'recommended', label: 'Recommended' },
  { value: 'rating', label: 'Rating' },
  { value: 'eta', label: 'Delivery time' },
  { value: 'distance', label: 'Distance' },
  { value: 'cost_asc', label: 'Cost: low to high' },
  { value: 'cost_desc', label: 'Cost: high to low' },
];

type Toggle = 'pureVeg' | 'offers' | 'openNow' | 'rating4';
const TOGGLES: { key: Toggle; label: string }[] = [
  { key: 'pureVeg', label: 'Pure veg' },
  { key: 'offers', label: 'Offers' },
  { key: 'openNow', label: 'Open now' },
  { key: 'rating4', label: 'Rating 4.0+' },
];

function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'h-11 shrink-0 rounded-full border px-4 text-sm font-medium',
        pressed
          ? 'border-brand-700 bg-brand-50 text-brand-800'
          : 'border-gray-300 bg-white text-gray-800 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}

/** Home / discovery: restaurants that deliver here, with filters and sort (FR-DISC-001…008). */
export function HomePage() {
  const location = useDeliveryLocation();
  const navigate = useNavigate();
  const [sort, setSort] = useState<Sort>('recommended');
  const [toggles, setToggles] = useState<Record<Toggle, boolean>>({
    pureVeg: false,
    offers: false,
    openNow: false,
    rating4: false,
  });
  const [cuisines, setCuisines] = useState<string[]>([]);
  const point = location ? { lat: location.lat, lng: location.lng } : null;

  const serviceability = useQuery({
    queryKey: ['serviceability', point],
    queryFn: () => customer.geo.serviceability(point!),
    enabled: Boolean(point),
  });
  const cuisineList = useQuery({
    queryKey: ['cuisines', point],
    queryFn: () => customer.discovery.cuisines(point!),
    enabled: Boolean(point),
  });
  const filters = {
    sort,
    ...(cuisines.length ? { cuisines } : {}),
    ...(toggles.pureVeg ? { pureVeg: true } : {}),
    ...(toggles.offers ? { offers: true } : {}),
    ...(toggles.openNow ? { openNow: true } : {}),
    ...(toggles.rating4 ? { minRating: 4 } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: ['restaurants', point, filters],
    queryFn: ({ pageParam }) =>
      customer.discovery.restaurants(point!, {
        ...filters,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(point),
  });

  if (!location) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-gray-900">Hungry? Let’s find food near you.</h1>
        <EmptyState
          title="Set your delivery location"
          description="We’ll show restaurants that deliver to you, with live delivery times and fees."
          action={
            <Link
              to="/location"
              className="inline-flex h-11 items-center rounded-lg bg-brand-700 px-4 text-sm font-medium text-white hover:bg-brand-800"
            >
              Choose location
            </Link>
          }
        />
      </div>
    );
  }

  const restaurants = list.data?.pages.flatMap((p) => p.data) ?? [];
  const notServiceable = serviceability.data && !serviceability.data.serviceable;

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Restaurants near {location.label}</h1>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get('q');
          navigate(`/search${q ? `?q=${encodeURIComponent(String(q))}` : ''}`);
        }}
      >
        <label className="sr-only" htmlFor="home-search">
          Search restaurants and dishes
        </label>
        <input
          id="home-search"
          name="q"
          type="search"
          placeholder="Search restaurants and dishes"
          className="block h-12 w-full rounded-xl border border-gray-300 bg-white px-4 text-base focus:border-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-200"
          onFocus={(e) => !e.currentTarget.value && navigate('/search')}
        />
      </form>

      {notServiceable && (
        <Alert tone="warning" title="Outside our delivery area">
          {SERVICEABILITY_TEXT[serviceability.data.reason ?? 'OUTSIDE_ZONE'] ??
            SERVICEABILITY_TEXT.OUTSIDE_ZONE}{' '}
          <Link to="/location" className="font-medium text-brand-700 underline">
            Change location
          </Link>
        </Alert>
      )}

      {cuisineList.data && cuisineList.data.length > 0 && (
        <div
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
          aria-label="Cuisines"
          role="group"
        >
          {cuisineList.data.map((c) => (
            <Chip
              key={c.slug}
              pressed={cuisines.includes(c.slug)}
              onClick={() =>
                setCuisines((cur) =>
                  cur.includes(c.slug) ? cur.filter((s) => s !== c.slug) : [...cur, c.slug],
                )
              }
            >
              {c.name}
            </Chip>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div
          className="-mx-4 flex flex-1 gap-2 overflow-x-auto px-4 pb-1"
          role="group"
          aria-label="Filters"
        >
          {TOGGLES.map((t) => (
            <Chip
              key={t.key}
              pressed={toggles[t.key]}
              onClick={() => setToggles((cur) => ({ ...cur, [t.key]: !cur[t.key] }))}
            >
              {t.label}
            </Chip>
          ))}
        </div>
        <div className="w-48">
          <Select label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <section aria-labelledby="restaurants-heading" aria-busy={list.isFetching}>
        <h2 id="restaurants-heading" className="mb-2 text-lg font-semibold text-gray-900">
          {list.isSuccess
            ? `${restaurants.length}${list.hasNextPage ? '+' : ''} restaurants`
            : 'Restaurants'}
        </h2>
        {list.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner label="Loading restaurants" />
          </div>
        ) : list.isError ? (
          <ErrorState
            title="Couldn’t load restaurants"
            description={list.error.message}
            action={<Button onClick={() => void list.refetch()}>Try again</Button>}
          />
        ) : restaurants.length === 0 ? (
          <EmptyState
            title="No restaurants match"
            description="Try removing a filter or choosing another location."
          />
        ) : (
          <ul className="space-y-3">
            {restaurants.map((r) => (
              <RestaurantCard key={r.branchId} card={r} />
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <Button
            variant="secondary"
            className="mt-3 w-full"
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Show more restaurants
          </Button>
        )}
      </section>
    </div>
  );
}
