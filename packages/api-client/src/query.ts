import { QueryClient, useQuery } from '@tanstack/react-query';
import type { ApiClient } from './client';
import { isApiClientError } from './errors';

/**
 * Shared TanStack Query defaults (SRS §19.3): queries retry at most twice and
 * only for retryable failures (network errors, 5xx); 4xx errors are final.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          failureCount < 2 && (!isApiClientError(error) || error.retryable),
      },
      mutations: { retry: false },
    },
  });
}

export const queryKeys = {
  readiness: ['system', 'readiness'] as const,
};

/** Platform status shown on app shells; polls every 30 s. */
export function useReadiness(client: ApiClient) {
  return useQuery({
    queryKey: queryKeys.readiness,
    queryFn: () => client.readiness(),
    refetchInterval: 30_000,
  });
}
