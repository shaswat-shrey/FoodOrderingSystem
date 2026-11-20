import { createBrowserRouter, type RouteObject } from 'react-router';
import { authRoutes, RequireAuth } from '@fos/auth-web';
import { AppLayout } from './components/AppLayout';
import { AUTH_CONFIG } from './lib/auth';
import { BankPage } from './pages/BankPage';
import { DeliveryPage } from './pages/DeliveryPage';
import { EarningsPage } from './pages/EarningsPage';
import { HistoryPage } from './pages/HistoryPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { RouteErrorPage } from './pages/RouteErrorPage';

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
          { path: 'delivery', element: <DeliveryPage /> },
          { path: 'earnings', element: <EarningsPage /> },
          { path: 'history', element: <HistoryPage /> },
          { path: 'account/bank', element: <BankPage /> },
          { path: 'account/profile', element: <ProfilePage /> },
        ],
      },
      ...authRoutes({ allowSignUp: AUTH_CONFIG.allowSignUp }),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
