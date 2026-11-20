import { Link, Outlet, useLocation } from 'react-router';
import { APP_INFO } from '../app-info';
import { useCart } from '../lib/cart';
import { rupees } from '../lib/format';
import { useDeliveryLocation } from '../lib/location';
import { AccountMenu } from './AccountMenu';

const NO_CART_BAR = [
  '/cart',
  '/checkout',
  '/orders',
  '/sign-in',
  '/sign-up',
  '/location',
  '/account',
  '/notifications',
  '/help',
];

/** Sticky "View cart" bar on browsing screens (UI §17.1.1 restaurant page). */
function CartBar() {
  const { pathname } = useLocation();
  const { data: cart } = useCart();
  if (!cart || cart.itemCount === 0 || NO_CART_BAR.some((p) => pathname.startsWith(p))) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 px-4 pb-4">
      <Link
        to="/cart"
        className="mx-auto flex h-14 max-w-2xl items-center justify-between rounded-xl bg-brand-700 px-4 text-white shadow-lg hover:bg-brand-800"
      >
        <span className="text-sm">
          <span className="font-semibold">
            {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}
          </span>
          {cart.preview && <> · {rupees(cart.preview.itemsSubtotal)}</>}
          {cart.branch && (
            <span className="block text-xs opacity-90">{cart.branch.restaurantName}</span>
          )}
        </span>
        <span className="font-semibold">View cart →</span>
      </Link>
    </div>
  );
}

export function AppLayout() {
  const location = useDeliveryLocation();
  return (
    <div className="min-h-dvh bg-gray-50 pb-24">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between gap-2 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/" className="shrink-0 text-lg font-bold text-brand-700">
              {APP_INFO.title}
            </Link>
            <Link
              to="/location"
              className="flex min-h-11 min-w-0 items-center gap-1 truncate text-sm text-gray-700 hover:text-brand-700"
              aria-label={
                location ? `Delivering to ${location.label}. Change location` : 'Set your location'
              }
            >
              <span aria-hidden="true">📍</span>
              <span className="truncate">{location ? location.label : 'Set location'}</span>
            </Link>
          </div>
          <AccountMenu />
        </div>
      </header>
      <main id="main" className="mx-auto max-w-2xl px-4 py-5">
        <Outlet />
      </main>
      <CartBar />
    </div>
  );
}
