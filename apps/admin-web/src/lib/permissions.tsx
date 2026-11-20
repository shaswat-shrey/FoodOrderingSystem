import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * The signed-in admin's platform permissions (GET /me/permissions). While it
 * loads, or if it can't be read, everything is shown and the API's 403s decide.
 */
export function usePermissions() {
  const q = useQuery({
    queryKey: ['me', 'permissions'],
    queryFn: () => api.auth.permissions(),
    staleTime: 5 * 60_000,
  });
  const perms = q.data ? new Set(q.data.permissions) : null;
  return {
    loaded: Boolean(q.data),
    roles: q.data?.platformRoles ?? [],
    can: (permission: string) => !perms || perms.has(permission),
  };
}
