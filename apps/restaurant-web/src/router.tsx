import { createBrowserRouter, type RouteObject } from 'react-router';
import { authRoutes, RequireAuth } from '@fos/auth-web';
import { AppLayout } from './components/AppLayout';
import { AUTH_CONFIG } from './lib/auth';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DishEditorPage } from './pages/DishEditorPage';
import { HomePage } from './pages/HomePage';
import { InvitePage } from './pages/InvitePage';
import { KitchenPage } from './pages/KitchenPage';
import { MenuPage } from './pages/MenuPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OptionGroupsPage } from './pages/OptionGroupsPage';
import { OrdersPage } from './pages/OrdersPage';
import { OutletPage } from './pages/OutletPage';
import { PayoutsPage } from './pages/PayoutsPage';
import { ProfilePage } from './pages/ProfilePage';
import { ReviewsPage } from './pages/ReviewsPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
import { TeamPage } from './pages/TeamPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'orders', element: <OrdersPage /> },
          { path: 'kitchen', element: <KitchenPage /> },
          { path: 'menu', element: <MenuPage /> },
          { path: 'menu/items/:itemId', element: <DishEditorPage /> },
          { path: 'menu/groups', element: <OptionGroupsPage /> },
          { path: 'outlet', element: <OutletPage /> },
          { path: 'team', element: <TeamPage /> },
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'analytics', element: <AnalyticsPage /> },
          { path: 'reviews', element: <ReviewsPage /> },
          { path: 'payouts', element: <PayoutsPage /> },
          { path: 'profile', element: <ProfilePage /> },
        ],
      },
      { path: 'invite/:token', element: <InvitePage /> },
      ...authRoutes({ allowSignUp: AUTH_CONFIG.allowSignUp }),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
