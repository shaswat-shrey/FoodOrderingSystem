import { createBrowserRouter, type RouteObject } from 'react-router';
import { authRoutes, RequireAuth } from '@fos/auth-web';
import { AppLayout } from './components/AppLayout';
import { AUTH_CONFIG } from './lib/auth';
import { CartPage } from './pages/CartPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { HomePage } from './pages/HomePage';
import { LocationPage } from './pages/LocationPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrderPage } from './pages/OrderPage';
import { PaymentPage } from './pages/PaymentPage';
import { RestaurantPage } from './pages/RestaurantPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
import { SearchPage } from './pages/SearchPage';

/** The ordering journey: browsing is public; cart, checkout and orders need sign-in. */
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
