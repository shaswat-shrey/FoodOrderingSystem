import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { FavoriteRestaurant } from '@fos/api-client';
import { Button, EmptyState, ErrorState, Spinner } from '@fos/ui';
import { PageTitle } from '../components/account-ui';
import { ServerError } from '../components/ui';
import { customer } from '../lib/customer';
import { closedReason, etaRange, ratingText } from '../lib/format';
import { useDeliveryLocation } from '../lib/location';

/** Favourite restaurants (API-FAV-001/003), checked against the delivery location. */
export function FavouritesPage() {
  const qc = useQueryClient();
  const location = useDeliveryLocation();
  const point = location ? { lat: location.lat, lng: location.lng } : undefined;
  const key = ['favorites', 'restaurants', point ?? null];
  const favorites = useQuery({
    queryKey: key,
    queryFn: () => customer.favorites.restaurants(point),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function remove(f: FavoriteRestaurant) {
    setBusy(f.restaurantId);
    setError(null);
    try {
      await customer.favorites.removeRestaurant(f.restaurantId);
      qc.setQueryData<FavoriteRestaurant[]>(key, (list) =>
        list?.filter((x) => x.restaurantId !== f.restaurantId),
      );
      void qc.invalidateQueries({ queryKey: ['favorites'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageTitle>Favourites</PageTitle>
      <ServerError error={error} />
      {favorites.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner label="Loading favourites" />
        </div>
      ) : favorites.isError ? (
        <ErrorState
          title="Couldn’t load your favourites"
          description={favorites.error.message}
          action={<Button onClick={() => void favorites.refetch()}>Try again</Button>}
        />
      ) : favorites.data.length === 0 ? (
        <EmptyState
          title="No favourites yet"
          description="Tap ♥ on a restaurant to keep it here."
          action={
            <Link to="/" className="font-medium text-brand-700 underline">
              Browse restaurants
            </Link>
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Favourite restaurants">
          {favorites.data.map((f) => {
            const c = f.card;
            const name = c?.restaurantName ?? 'Restaurant';
            return (
              <li
                key={f.restaurantId}
                className="flex items-start justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
              >
                <div className="min-w-0">
                  {c ? (
                    <Link
                      to={`/restaurants/${c.branchId}`}
                      className="font-semibold text-gray-900 hover:text-brand-700 hover:underline"
                    >
                      {name}
                    </Link>
                  ) : (
                    <p className="font-semibold text-gray-900">{name}</p>
                  )}
                  {c && (
                    <p className="text-sm text-gray-600">
                      {[
                        c.area,
                        ratingText(c.rating),
                        c.delivery?.serviceable ? etaRange(c.delivery.eta) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  {c && !c.status.acceptingOrders && (
                    <p className="text-sm text-warning-600">{closedReason(c.status.reason)}</p>
                  )}
                  {!f.serviceable && location && (
                    <p className="text-sm text-gray-500">Doesn’t deliver to {location.label}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === f.restaurantId}
                  onClick={() => void remove(f)}
                  aria-label={`Remove ${name} from favourites`}
                >
                  ♥ Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
