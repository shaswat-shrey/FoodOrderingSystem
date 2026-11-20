import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { isApiClientError, type ReorderResult } from '@fos/api-client';
import { Alert, Button } from '@fos/ui';
import { Dialog, ServerError } from '../components/ui';
import { cartKey } from './cart';
import { customer } from './customer';

/**
 * "Reorder" (FR-CORD-008): rebuilds the cart from a past order at today's prices.
 * Everything available → straight to the cart; some lines skipped → say which;
 * a cart from another restaurant → ask before replacing it.
 */
export function useReorder() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ orderId: string; message: string } | null>(null);
  const [partial, setPartial] = useState<{ orderId: string; result: ReorderResult } | null>(null);
  const [error, setError] = useState<{ orderId: string; error: unknown } | null>(null);

  async function reorder(orderId: string, replaceCart = false) {
    setBusy(orderId);
    setError(null);
    setPartial(null);
    try {
      const result = await customer.orders.reorder(orderId, replaceCart);
      qc.setQueryData([...cartKey, null], result.cart);
      void qc.invalidateQueries({ queryKey: cartKey });
      if (result.skipped.length > 0) setPartial({ orderId, result });
      else navigate('/cart');
    } catch (e) {
      if (isApiClientError(e) && e.code === 'CART_BRANCH_CONFLICT')
        setConflict({ orderId, message: e.message });
      else setError({ orderId, error: e });
    } finally {
      setBusy(null);
    }
  }

  /** Inline outcome for one order (place it next to that order's Reorder button). */
  const outcome = (orderId: string) => (
    <>
      {error?.orderId === orderId && <ServerError error={error.error} />}
      {partial?.orderId === orderId && (
        <Alert tone="warning" title="Some items couldn’t be added">
          <p>
            {partial.result.skipped.map((s) => s.itemName).join(', ')}{' '}
            {partial.result.skipped.length === 1 ? 'isn’t' : 'aren’t'} available right now.
            {partial.result.added.length > 0 &&
              ` We added ${partial.result.added.join(', ')} to your cart.`}
          </p>
          <Link to="/cart" className="mt-1 inline-block font-medium text-brand-700 underline">
            View cart
          </Link>
        </Alert>
      )}
    </>
  );

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
            onClick={() => {
              const id = conflict.orderId;
              setConflict(null);
              void reorder(id, true);
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

  return { reorder, busy, outcome, prompt };
}
