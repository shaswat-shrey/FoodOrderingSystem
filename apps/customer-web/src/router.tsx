import { createBrowserRouter, type RouteObject } from 'react-router';
import { authRoutes, RequireAuth } from '@fos/auth-web';
import { AppLayout } from './components/AppLayout';
import { AUTH_CONFIG } from './lib/auth';
import { AccountPage } from './pages/AccountPage';
import { AddressesPage } from './pages/AddressesPage';
import { CartPage } from './pages/CartPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { FavouritesPage } from './pages/FavouritesPage';
import { HomePage } from './pages/HomePage';
import { LocationPage } from './pages/LocationPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrderPage } from './pages/OrderPage';
import { OrdersPage } from './pages/OrdersPage';
import { PaymentPage } from './pages/PaymentPage';
import { ProfilePage } from './pages/ProfilePage';
import { RestaurantPage } from './pages/RestaurantPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { SearchPage } from './pages/SearchPage';
import { SupportPage } from './pages/SupportPage';
import { TicketPage } from './pages/TicketPage';
import { WalletPage } from './pages/WalletPage';

/**
 * The ordering journey and account area: browsing is public; cart, checkout,
 * orders and the account screens need sign-in.
 */
export const shopRoutes: RouteObject[] = [
  { index: true, element: <HomePage /> },
  { path: 'location', element: <LocationPage /> },
  { path: 'search', element: <SearchPage /> },
  { path: 'restaurants/:branchId', element: <RestaurantPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: 'cart', element: <CartPage /> },
      { path: 'checkout', element: <CheckoutPage /> },
      { path: 'orders/:orderId', element: <OrderPage /> },
      { path: 'orders/:orderId/pay', element: <PaymentPage /> },
      { path: 'orders', element: <OrdersPage /> },
      { path: 'account', element: <AccountPage /> },
      { path: 'account/profile', element: <ProfilePage /> },
      { path: 'account/addresses', element: <AddressesPage /> },
      { path: 'account/wallet', element: <WalletPage /> },
      { path: 'account/favourites', element: <FavouritesPage /> },
      { path: 'account/reviews', element: <ReviewsPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      { path: 'help', element: <SupportPage /> },
      { path: 'help/tickets/:ticketId', element: <TicketPage /> },
    ],
  },
];

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      ...shopRoutes,
      ...authRoutes({ allowSignUp: AUTH_CONFIG.allowSignUp }),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
