import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { CartLine } from '@fos/api-client';
import { Alert, Button, DietaryMarker, EmptyState, ErrorState, Spinner } from '@fos/ui';
import { PriceBreakdown, QuantityStepper, Section, ServerError } from '../components/ui';
import { cartKey, useCart } from '../lib/cart';
import { customer } from '../lib/customer';
import { rupees } from '../lib/format';
import { useDeliveryLocation } from '../lib/location';

/** Cart: lines, flags, coupon and the server's price breakdown (FR-CART-001…013). */
export function CartPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useDeliveryLocation();
  const at = location
    ? location.addressId
      ? { addressId: location.addressId }
      : { lat: location.lat, lng: location.lng }
    : null;
  const cart = useCart(at);
  const [error, setError] = useState<unknown>(null);
  const [busyLine, setBusyLine] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: cartKey });

  async function setQuantity(line: CartLine, quantity: number) {
    setBusyLine(line.id);
    setError(null);
    try {
      if (quantity === 0) await customer.cart.removeLine(line.id);
      else await customer.cart.setQuantity(line.id, quantity, cart.data?.version);
    } catch (e) {
      setError(e);
    } finally {
      setBusyLine(null);
      await refresh();
    }
  }

  if (cart.isPending)
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading your cart" />
      </div>
    );
  if (cart.isError)
    return (
      <ErrorState
        title="Couldn’t load your cart"
        description={cart.error.message}
        action={<Button onClick={() => void cart.refetch()}>Try again</Button>}
      />
    );
  const c = cart.data;
  if (!c.branch || c.lines.length === 0)
    return (
      <EmptyState
        title="Your cart is empty"
        description="Add dishes from a restaurant to get started."
        action={
          <Link to="/" className="font-medium text-brand-700 underline">
            Browse restaurants
          </Link>
        }
      />
    );

  const blocking = c.blocking.filter((b) => !b.lineId);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Your cart</h1>
        <Link to={`/restaurants/${c.branch.id}`} className="text-sm text-brand-700 underline">
          {c.branch.restaurantName}
        </Link>
      </div>
      <div aria-live="polite" className="space-y-2">
        <ServerError error={error} />
        {blocking.map((b) => (
          <Alert key={b.code} tone="warning">
            {b.message}
          </Alert>
        ))}
        {c.warnings.map((w) => (
          <Alert key={`${w.code}:${w.lineId ?? ''}`} tone="info">
            {w.message}
          </Alert>
        ))}
      </div>

      <Section title="Items">
        <ul className="divide-y divide-gray-100">
          {c.lines.map((line) => (
            <li key={line.id} className="py-3">
              <div className="flex items-start gap-2">
                {line.dietaryMarker && <DietaryMarker type={line.dietaryMarker} className="mt-1" />}
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900">{line.name}</p>
                  {(line.variant || line.options.length > 0) && (
                    <p className="text-sm text-gray-600">
                      {[line.variant?.name, ...line.options.map((o) => o.name)]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                  )}
                  {line.instructions && (
                    <p className="text-xs text-gray-500">“{line.instructions}”</p>
                  )}
                  {line.status === 'PRICE_CHANGED' && (
                    <p className="text-sm text-warning-600" role="status">
                      Price changed from {rupees(line.previousUnitAmount)} to{' '}
                      {rupees(line.unitAmount)}
                    </p>
                  )}
                  {line.status !== 'OK' && line.status !== 'PRICE_CHANGED' && (
                    <p className="text-sm text-danger-600">
                      {line.message ?? 'This item can’t be ordered right now.'}
                    </p>
                  )}
                </div>
                <span className="font-medium tabular-nums">{rupees(line.lineAmount)}</span>
              </div>
              <div className="mt-2 flex justify-end">
                {line.status === 'OK' || line.status === 'PRICE_CHANGED' ? (
                  <QuantityStepper
                    value={line.quantity}
                    label={line.name}
                    disabled={busyLine === line.id}
                    onChange={(q) => void setQuantity(line, q)}
                  />
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => void setQuantity(line, 0)}>
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <CouponBox applied={c.coupon?.code ?? null} notice={c.preview?.couponNotice ?? null} />

      {c.preview && (
        <Section title="Bill details">
          <PriceBreakdown quote={c.preview} />
          {!location && (
            <p className="mt-2 text-xs text-gray-500">
              <Link to="/location?next=/cart" className="text-brand-700 underline">
                Set your location
              </Link>{' '}
              to see the delivery fee.
            </p>
          )}
        </Section>
      )}

      <Button
        size="lg"
        className="w-full"
        disabled={c.blocking.length > 0}
        onClick={() => navigate('/checkout')}
      >
        Proceed to checkout
      </Button>
    </div>
  );
}

function CouponBox({ applied, notice }: { applied: string | null; notice: string | null }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply(e: FormEvent) {
    e.preventDefault();
    if (code.trim().length < 2) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await customer.cart.applyCoupon(code.trim());
      setMessage(
        result.coupon.freeDelivery && result.coupon.discountAmount === 0
          ? `${result.coupon.code} applied: free delivery`
          : `${result.coupon.code} applied: you save ${rupees(result.coupon.discountAmount)}`,
      );
      setCode('');
      await qc.invalidateQueries({ queryKey: cartKey });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await customer.cart.removeCoupon();
      await qc.invalidateQueries({ queryKey: cartKey });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Offers">
      {applied ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm">
            <span className="font-semibold text-success-600">{applied}</span> applied
          </p>
          <Button variant="ghost" size="sm" loading={busy} onClick={() => void remove()}>
            Remove coupon
          </Button>
        </div>
      ) : (
        <form className="flex items-end gap-2" onSubmit={apply}>
          <label className="block flex-1 text-sm">
            <span className="font-medium text-gray-800">Coupon code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              className="mt-1 block h-11 w-full rounded-md border border-gray-300 px-3 text-base uppercase"
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            loading={busy}
            disabled={code.trim().length < 2}
          >
            Apply
          </Button>
        </form>
      )}
      <div aria-live="polite" className="mt-2 space-y-2">
        {message && <Alert tone="success">{message}</Alert>}
        {notice && <Alert tone="info">{notice}</Alert>}
        <ServerError error={error} />
      </div>
    </Section>
  );
}
