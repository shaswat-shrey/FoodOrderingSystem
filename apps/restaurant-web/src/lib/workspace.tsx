import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MerchantMe } from '@fos/api-client';
import { merchant } from './merchant';

type Restaurant = MerchantMe['restaurants'][number];

interface Workspace {
  me: MerchantMe | undefined;
  loading: boolean;
  error: unknown;
  restaurant: Restaurant | null;
  branchId: string | null;
  selectRestaurant(id: string): void;
  selectBranch(id: string): void;
  /** Restaurant permission check for the selected restaurant (the API checks again). */
  can(permission: string): boolean;
  refresh(): Promise<unknown>;
}

const Ctx = createContext<Workspace | null>(null);
const KEY = 'fos.restaurant.workspace';

function remembered(): { restaurantId?: string; branchId?: string } {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as {
      restaurantId?: string;
      branchId?: string;
    };
  } catch {
    return {};
  }
}

/** Memberships from /merchant/me plus the selected restaurant and outlet (remembered per device). */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const query = useQuery({ queryKey: ['merchant', 'me'], queryFn: merchant.me, staleTime: 30_000 });
  const [sel, setSel] = useState(remembered);
  const me = query.data;
  const restaurant =
    me?.restaurants.find((r) => r.id === sel.restaurantId) ?? me?.restaurants[0] ?? null;
  const branchId =
    restaurant?.branches.find((b) => b.id === sel.branchId)?.id ??
    restaurant?.branches[0]?.id ??
    null;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ restaurantId: restaurant?.id, branchId }));
    } catch {
      /* private mode */
    }
  }, [restaurant?.id, branchId]);

  const value = useMemo<Workspace>(
    () => ({
      me,
      loading: query.isLoading,
      error: query.error,
      restaurant,
      branchId,
      selectRestaurant: (id) => setSel({ restaurantId: id }),
      selectBranch: (id) => setSel((s) => ({ ...s, restaurantId: restaurant?.id, branchId: id })),
      can: (p) => Boolean(restaurant?.permissions.includes(p)),
      refresh: () => query.refetch(),
    }),
    [me, query, restaurant, branchId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): Workspace {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return v;
}
