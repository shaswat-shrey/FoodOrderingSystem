import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '@fos/auth-web';
import { isApiClientError } from '@fos/api-client';
import { Button } from '@fos/ui';
import { Dialog } from '../components/ui';
import { cartKey } from './cart';
import { customer } from './customer';

export type AddBody = Parameters<typeof customer.cart.add>[0];

/**
 * Adds a line to the cart. Guests are sent to sign in first; a cart from another
 * restaurant asks "Start a new cart?" (CART_BRANCH_CONFLICT, BR-CART-001).
 */
export function useAddToCart() {
  const qc = useQueryClient();
  const signedIn = useAuth().status === 'signedIn';
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const [conflict, setConflict] = useState<{ body: AddBody; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(body: AddBody): Promise<boolean> {
    if (!signedIn) {
      navigate(`/sign-in?next=${encodeURIComponent(pathname + search)}`);
      return false;
    }
    setBusy(true);
    try {
      const cart = await customer.cart.add(body);
      qc.setQueryData([...cartKey, null], cart);
      await qc.invalidateQueries({ queryKey: cartKey });
      return true;
    } catch (error) {
      if (isApiClientError(error) && error.code === 'CART_BRANCH_CONFLICT') {
        setConflict({ body, message: error.message });
        return false;
      }
      throw error;
    } finally {
      setBusy(false);
    }
  }

  const prompt = conflict && (
    <Dialog
      title="Start a new cart?"
      onClose={() => setConflict(null)}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setConflict(null)}>
            Keep current cart
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              const body = conflict.body;
              setConflict(null);
              await add({ ...body, replaceCart: true }).catch(() => undefined);
            }}
          >
            Start new cart
          </Button>
        </div>
      }
    >
      <p className="text-sm text-gray-700">{conflict.message}</p>
      <p className="mt-2 text-sm text-gray-600">
        Starting a new cart removes the items already in it.
      </p>
    </Dialog>
  );

  return { add, busy, prompt };
}
