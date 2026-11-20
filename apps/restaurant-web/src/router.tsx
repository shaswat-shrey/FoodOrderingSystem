import { createBrowserRouter, type RouteObject } from 'react-router';
import { authRoutes, RequireAuth } from '@fos/auth-web';
import { AppLayout } from './components/AppLayout';
import { AUTH_CONFIG } from './lib/auth';
import { DashboardPage } from './pages/DashboardPage';
import { HomePage } from './pages/HomePage';
import { InvitePage } from './pages/InvitePage';
import { KitchenPage } from './pages/KitchenPage';
import { MenuPage } from './pages/MenuPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrdersPage } from './pages/OrdersPage';
import { OutletPage } from './pages/OutletPage';
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
          { path: 'outlet', element: <OutletPage /> },
          { path: 'team', element: <TeamPage /> },
          { path: 'dashboard', element: <DashboardPage /> },
        ],
      },
      { path: 'invite/:token', element: <InvitePage /> },
      ...authRoutes({ allowSignUp: AUTH_CONFIG.allowSignUp }),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
