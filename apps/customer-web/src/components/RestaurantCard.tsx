import { Link } from 'react-router';
import type { BranchCard } from '@fos/api-client';
import { cn } from '@fos/ui';
import { etaRange, ratingText, rupees, closedReason } from '../lib/format';

const CLOSED = new Set(['CLOSED', 'PAUSED', 'UNAVAILABLE']);

export function RestaurantCard({ card }: { card: BranchCard }) {
  const closed = CLOSED.has(card.status.state) || !card.status.acceptingOrders;
  const undeliverable = card.delivery && !card.delivery.serviceable;
  return (
    <li>
      <Link
        to={`/restaurants/${card.branchId}`}
        className={cn(
          'flex gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm hover:border-brand-300',
          (closed || undeliverable) && 'opacity-70',
        )}
      >
        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-gray-100">
          {(card.coverUrl ?? card.logoUrl) && (
            <img
              src={card.coverUrl ?? card.logoUrl ?? ''}
              alt=""
              className="h-full w-full object-cover"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-gray-900">{card.restaurantName}</h3>
          <p className="truncate text-sm text-gray-600">
            {card.cuisines.join(', ')} · {card.area}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-3 text-sm text-gray-800">
            <span>{ratingText(card.rating)}</span>
            {card.delivery && <span>{etaRange(card.delivery.eta)}</span>}
            {card.delivery && (
              <span>
                {card.delivery.deliveryFeeAmount === 0
                  ? 'Free delivery'
                  : `${rupees(card.delivery.deliveryFeeAmount)} delivery`}
              </span>
            )}
            {card.pureVeg && <span className="text-veg">Pure veg</span>}
          </p>
          {card.bestOffer && (
            <p className="mt-1 text-sm font-medium text-brand-700">{card.bestOffer}</p>
          )}
          {closed && (
            <p className="mt-1 text-sm font-medium text-danger-600">
              {closedReason(card.status.reason)}
              {card.status.opensAt &&
                ` · Opens ${new Date(card.status.opensAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`}
            </p>
          )}
          {!closed && undeliverable && (
            <p className="mt-1 text-sm text-danger-600">Doesn’t deliver to your location</p>
          )}
        </div>
      </Link>
    </li>
  );
}
