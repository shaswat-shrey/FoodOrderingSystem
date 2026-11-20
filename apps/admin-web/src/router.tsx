import { createBrowserRouter, type RouteObject } from 'react-router';
import { authRoutes, RequireAuth } from '@fos/auth-web';
import { AppLayout } from './components/AppLayout';
import { AUTH_CONFIG } from './lib/auth';
import {
  ApprovalsPage,
  PartnerApplicationPage,
  RestaurantApplicationPage,
} from './pages/ApprovalsPage';
import { CouponPage, CouponsPage, NewCouponPage } from './pages/CouponsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DispatchPage } from './pages/DispatchPage';
import {
  PaymentPage,
  PaymentsPage,
  PayoutBatchPage,
  PayoutsPage,
  RefundsPage,
} from './pages/FinancePages';
import { AuditPage, JobsPage, ReviewsPage, RolesPage } from './pages/GovernancePages';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrderPage, OrdersPage } from './pages/OrdersPage';
import { PartnerPage, PartnersPage } from './pages/PartnersPage';
import { PricingPage } from './pages/PricingPage';
import { ChangeRequestsPage, RestaurantPage, RestaurantsPage } from './pages/RestaurantsPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
import { SettingsPage } from './pages/SettingsPage';
import { SupportPage, TicketPage } from './pages/SupportPage';
import { UserPage, UsersPage } from './pages/UsersPage';
import { ZonePage, ZonesPage } from './pages/ZonesPage';

/** Signed-in admin console screens (Phase 11). */
export const consoleRoutes: RouteObject[] = [
  { index: true, element: <DashboardPage /> },
  { path: 'approvals', element: <ApprovalsPage /> },
  { path: 'approvals/restaurants/:id', element: <RestaurantApplicationPage /> },
  { path: 'approvals/partners/:id', element: <PartnerApplicationPage /> },
  { path: 'users', element: <UsersPage /> },
  { path: 'users/:id', element: <UserPage /> },
  { path: 'restaurants', element: <RestaurantsPage /> },
  { path: 'restaurants/:id', element: <RestaurantPage /> },
  { path: 'change-requests', element: <ChangeRequestsPage /> },
  { path: 'partners', element: <PartnersPage /> },
  { path: 'partners/:id', element: <PartnerPage /> },
  { path: 'orders', element: <OrdersPage /> },
  { path: 'orders/:id', element: <OrderPage /> },
  { path: 'dispatch', element: <DispatchPage /> },
  { path: 'payments', element: <PaymentsPage /> },
  { path: 'payments/:id', element: <PaymentPage /> },
  { path: 'refunds', element: <RefundsPage /> },
  { path: 'payouts', element: <PayoutsPage /> },
  { path: 'payouts/:id', element: <PayoutBatchPage /> },
  { path: 'coupons', element: <CouponsPage /> },
  { path: 'coupons/new', element: <NewCouponPage /> },
  { path: 'coupons/:id', element: <CouponPage /> },
  { path: 'zones', element: <ZonesPage /> },
  { path: 'zones/:id', element: <ZonePage /> },
  { path: 'pricing', element: <PricingPage /> },
  { path: 'settings', element: <SettingsPage /> },
  { path: 'support', element: <SupportPage /> },
  { path: 'support/:id', element: <TicketPage /> },
  { path: 'reviews', element: <ReviewsPage /> },
  { path: 'roles', element: <RolesPage /> },
  { path: 'audit', element: <AuditPage /> },
  { path: 'jobs', element: <JobsPage /> },
];

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { element: <RequireAuth />, children: consoleRoutes },
      ...authRoutes({ allowSignUp: AUTH_CONFIG.allowSignUp }),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
