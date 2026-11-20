import { createBrowserRouter, type RouteObject } from 'react-router';
import { authRoutes } from '@fos/auth-web';
import { AppLayout } from './components/AppLayout';
import { AUTH_CONFIG } from './lib/auth';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RouteErrorPage } from './pages/RouteErrorPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      // Browsing is public; checkout and account screens require sign-in (Phase 12).
      { index: true, element: <HomePage /> },
      ...authRoutes({ allowSignUp: AUTH_CONFIG.allowSignUp }),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
