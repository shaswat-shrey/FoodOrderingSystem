import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { createQueryClient } from '@fos/api-client';
import { AuthProvider } from '@fos/auth-web';
import { api } from './lib/api';
import { live } from './lib/live';
import { AUTH_CONFIG } from './lib/auth';
import { router } from './router';
import './index.css';

const queryClient = createQueryClient();
live.start();
const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider api={api} config={AUTH_CONFIG}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
