import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@fos/auth-web';
import type { CartPricingPoint } from '@fos/api-client';
import { customer } from './customer';

export const cartKey = ['cart'] as const;

/** The signed-in customer's cart, priced for `at` when given (guests have none). */
export function useCart(at?: CartPricingPoint) {
  const signedIn = useAuth().status === 'signedIn';
  return useQuery({
    queryKey: [...cartKey, at ?? null],
    queryFn: () => customer.cart.get(at ?? undefined),
    enabled: signedIn,
  });
}
