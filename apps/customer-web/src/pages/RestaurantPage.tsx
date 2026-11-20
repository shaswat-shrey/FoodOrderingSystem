import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useAuth } from '@fos/auth-web';
import { isApiClientError, type BranchPage, type ItemCard } from '@fos/api-client';
import { Alert, Button, DietaryMarker, ErrorState, Spinner, cn } from '@fos/ui';
import { ItemSheet } from '../components/ItemSheet';
import { QuantityStepper, ServerError } from '../components/ui';
import { useAddToCart } from '../lib/add-to-cart';
import { cartKey, useCart } from '../lib/cart';
import { customer } from '../lib/customer';
import { etaRange, ratingText, rupees, SERVICEABILITY_TEXT, closedReason } from '../lib/format';
import { useDeliveryLocation } from '../lib/location';
import { NotFoundPage } from './NotFoundPage';

const STATE_LABEL: Record<BranchPage['status']['state'], string> = {
  OPEN: 'Open now',
  CLOSING_SOON: 'Closing soon',
  CLOSED: 'Closed',
  PAUSED: 'Not taking orders',
  UNAVAILABLE: 'Unavailable',
};

/** Restaurant details and menu (UI §17.1.1; FR-MENU-001…006). */
export function RestaurantPage() {
  const { branchId = '' } = useParams();
  const location = useDeliveryLocation();
  const point = location ? { lat: location.lat, lng: location.lng } : undefined;
  const [vegOnly, setVegOnly] = useState(false);
  const page = useQuery({
    queryKey: ['branch', branchId, point ?? null],
    queryFn: () => customer.branches.page(branchId, point),
  });
  const menu = useQuery({
    queryKey: ['menu', branchId, vegOnly],
    queryFn: () => customer.branches.menu(branchId, vegOnly || undefined),
  });
  const offers = useQuery({
    queryKey: ['coupons', branchId],
    queryFn: () => customer.coupons.list(branchId),
  });

  if (page.isPending)
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading restaurant" />
      </div>
    );
  if (page.isError) {
    if (isApiClientError(page.error) && page.error.status === 404) return <NotFoundPage />;
    return (
      <ErrorState
        title="Couldn’t load this restaurant"
        description={page.error.message}
        action={<Button onClick={() => void page.refetch()}>Try again</Button>}
      />
    );
  }
  const b = page.data;
  const delivery = b.deliveryDetails;
  const open = b.status.acceptingOrders;

  return (
    <div className="space-y-4">
      <header className="space-y-2 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">{b.restaurantName}</h1>
            <p className="text-sm text-gray-600">
              {b.cuisines.join(', ')} · {b.area}
            </p>
          </div>
          <FavouriteToggle
            restaurantId={b.restaurantId}
            initial={b.isFavorite}
            name={b.restaurantName}
          />
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-gray-500">Status</dt>
            <dd className={cn('font-medium', open ? 'text-success-600' : 'text-danger-600')}>
              {STATE_LABEL[b.status.state]}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Rating</dt>
            <dd className="font-medium">{ratingText(b.rating)}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Delivery</dt>
            <dd className="font-medium">{delivery ? etaRange(delivery.eta) : '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Delivery fee</dt>
            <dd className="font-medium">
              {delivery
                ? delivery.deliveryFeeAmount === 0
                  ? 'Free'
                  : rupees(delivery.deliveryFeeAmount)
                : 'Set a location'}
            </dd>
          </div>
        </dl>
        {b.minOrderAmount > 0 && (
          <p className="text-xs text-gray-500">Minimum order {rupees(b.minOrderAmount)}</p>
        )}
        {b.fssaiNumber && <p className="text-xs text-gray-500">FSSAI Lic. No. {b.fssaiNumber}</p>}
        {!open && b.status.reason && b.status.reason !== 'OUTSIDE_HOURS' && (
          <Alert tone="warning">{closedReason(b.status.reason)}</Alert>
        )}
        {delivery && !delivery.serviceable && (
          <Alert tone="warning">
            {SERVICEABILITY_TEXT[delivery.reason ?? 'OUTSIDE_RADIUS'] ?? 'Doesn’t deliver here.'}
          </Alert>
        )}
      </header>

      {offers.data && offers.data.length > 0 && (
        <section aria-label="Offers" className="-mx-4 flex gap-2 overflow-x-auto px-4">
          {offers.data.map((o) => (
            <div
              key={o.code}
              className="min-w-56 shrink-0 rounded-lg border border-dashed border-brand-300 bg-brand-50 p-3 text-sm"
            >
              <p className="font-semibold text-brand-800">{o.code}</p>
              <p className="text-gray-700">{o.description}</p>
              {!o.eligible && o.reason && <p className="text-xs text-gray-500">{o.reason}</p>}
            </div>
          ))}
        </section>
      )}

      <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-gray-800">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={vegOnly}
          onChange={(e) => setVegOnly(e.target.checked)}
        />
        Veg only
      </label>

      {menu.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner label="Loading menu" />
        </div>
      ) : menu.isError ? (
        <ErrorState title="Couldn’t load the menu" description={menu.error.message} />
      ) : (
        <Menu branchId={b.branchId} categories={menu.data.categories} ordering={open} />
      )}
    </div>
  );
}

function FavouriteToggle({
  restaurantId,
  initial,
  name,
}: {
  restaurantId: string;
  initial: boolean;
  name: string;
}) {
  const signedIn = useAuth().status === 'signedIn';
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  if (!signedIn) return null;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      disabled={busy}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl hover:bg-gray-100"
      onClick={async () => {
        setBusy(true);
        setOn(!on);
        try {
          if (on) await customer.favorites.removeRestaurant(restaurantId);
          else await customer.favorites.addRestaurant(restaurantId);
        } catch {
          setOn(on);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span aria-hidden="true" className={on ? 'text-danger-600' : 'text-gray-400'}>
        {on ? '♥' : '♡'}
      </span>
    </button>
  );
}

function Menu({
  branchId,
  categories,
  ordering,
}: {
  branchId: string;
  categories: { id: string; name: string; description: string | null; items: ItemCard[] }[];
  ordering: boolean;
}) {
  const qc = useQueryClient();
  const { add, prompt } = useAddToCart();
  const { data: cart } = useCart();
  const [sheet, setSheet] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<string | null>(null);
  const lines = cart?.branch?.id === branchId ? cart.lines : [];

  async function quickAdd(item: ItemCard) {
    setError(null);
    setPending(item.id);
    try {
      await add({ branchId, foodItemId: item.id, quantity: 1, optionIds: [] });
    } catch (e) {
      setError(e);
    } finally {
      setPending(null);
    }
  }

  async function changeQuantity(lineId: string, quantity: number) {
    setError(null);
    try {
      await customer.cart.setQuantity(lineId, quantity, cart?.version);
    } catch (e) {
      setError(e);
    }
    await qc.invalidateQueries({ queryKey: cartKey });
  }

  if (categories.length === 0)
    return <p className="py-6 text-center text-sm text-gray-600">Nothing on the menu right now.</p>;

  return (
    <>
      <nav aria-label="Menu categories" className="sticky top-14 z-10 -mx-4 bg-gray-50 px-4 py-2">
        <ul className="flex gap-2 overflow-x-auto">
          {categories.map((c) => (
            <li key={c.id}>
              <a
                href={`#cat-${c.id}`}
                className="flex h-11 shrink-0 items-center whitespace-nowrap rounded-full bg-white px-4 text-sm font-medium text-gray-800 ring-1 ring-gray-300"
              >
                {c.name}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div aria-live="polite">
        <ServerError error={error} />
      </div>
      {categories.map((c) => (
        <section
          key={c.id}
          id={`cat-${c.id}`}
          aria-labelledby={`cat-h-${c.id}`}
          className="scroll-mt-28"
        >
          <h2 id={`cat-h-${c.id}`} className="mb-2 text-lg font-semibold text-gray-900">
            {c.name}
          </h2>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
            {c.items.map((item) => {
              const mine = lines.filter((l) => l.foodItemId === item.id);
              const inCart = mine.reduce((s, l) => s + l.quantity, 0);
              const single = !item.customizable && mine.length === 1 ? mine[0]! : null;
              return (
                <li key={item.id} id={`item-${item.id}`} className="flex gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <DietaryMarker type={item.dietaryMarker} />
                      {item.isBestseller && (
                        <span className="text-xs font-semibold text-warning-600">Bestseller</span>
                      )}
                    </div>
                    <h3 className="mt-1 font-medium text-gray-900">{item.name}</h3>
                    <p className="text-sm tabular-nums text-gray-800">
                      {rupees(item.priceAmount)}
                      {item.originalPriceAmount && item.originalPriceAmount > item.priceAmount && (
                        <s className="ml-2 text-gray-400">{rupees(item.originalPriceAmount)}</s>
                      )}
                    </p>
                    {item.description && (
                      <p className="mt-1 line-clamp-2 text-sm text-gray-600">{item.description}</p>
                    )}
                  </div>
                  <div className="flex w-28 shrink-0 flex-col items-center justify-center gap-1">
                    {item.imageUrl && (
                      <img
                        src={item.imageUrl}
                        alt=""
                        className="h-20 w-24 rounded-lg object-cover"
                      />
                    )}
                    {!item.available ? (
                      <span className="text-center text-xs text-gray-500">
                        {item.unavailableReason === 'OUT_OF_STOCK' ? 'Sold out' : 'Unavailable'}
                      </span>
                    ) : single ? (
                      <QuantityStepper
                        value={single.quantity}
                        label={item.name}
                        onChange={(q) => void changeQuantity(single.id, q)}
                      />
                    ) : (
                      <>
                        <Button
                          variant="secondary"
                          className="w-24 font-semibold text-brand-700"
                          disabled={!ordering}
                          loading={pending === item.id}
                          aria-label={`Add ${item.name}`}
                          onClick={() =>
                            item.customizable ? setSheet(item.id) : void quickAdd(item)
                          }
                        >
                          Add
                        </Button>
                        {item.customizable && (
                          <span className="text-xs text-gray-500">Customisable</span>
                        )}
                        {inCart > 0 && (
                          <span className="text-xs text-brand-700">{inCart} in cart</span>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {sheet && (
        <ItemSheet
          branchId={branchId}
          itemId={sheet}
          onClose={() => setSheet(null)}
          onAdd={async (body) => {
            const added = await add({ branchId, foodItemId: sheet, ...body });
            // A conflict prompt (or sign-in) takes over from the sheet.
            if (!added) setSheet(null);
            return added;
          }}
        />
      )}
      {prompt}
      <p className="pt-2 text-center text-sm">
        <Link to="/" className="text-brand-700 underline">
          Back to restaurants
        </Link>
      </p>
    </>
  );
}
