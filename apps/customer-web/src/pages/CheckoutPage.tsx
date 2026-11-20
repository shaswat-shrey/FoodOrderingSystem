import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  isApiClientError,
  type CheckoutOptionsBody,
  type CheckoutSession,
  type PaymentMethodKind,
} from '@fos/api-client';
import { Alert, Button, EmptyState, Spinner, cn } from '@fos/ui';
import { AddressForm } from '../components/AddressForm';
import { PriceBreakdown, Section, ServerError } from '../components/ui';
import { cartKey, useCart } from '../lib/cart';
import { customer } from '../lib/customer';
import { etaRange, rupees, SERVICEABILITY_TEXT } from '../lib/format';
import { useIdempotencyKey } from '../lib/idempotency';
import { useDeliveryLocation } from '../lib/location';

const TIPS = [0, 2_000, 3_000, 5_000];
const METHOD_LABEL: Record<PaymentMethodKind, string> = {
  ONLINE: 'Pay online (UPI, card, net banking)',
  COD: 'Cash on delivery',
  WALLET: 'Wallet',
};

/** Clear words for the 409/422 answers to "Place order" (FR-CHK-002, FR-PRICE-005). */
const CONFIRM_TEXT: Record<string, string> = {
  PRICE_CHANGED:
    'The total changed since you last looked. Check the new amount and place the order again.',
  CHECKOUT_SESSION_EXPIRED:
    'Your checkout timed out, so we refreshed it. Check the total and place the order again.',
  CART_CHANGED: 'Your cart changed since checkout started. Please review it.',
  IDEMPOTENCY_KEY_REUSED: 'Something changed while placing your order. Please try again.',
};

/** Checkout: address, payment, tip, contactless, final total, place order (FR-CHK-001…007). */
export function CheckoutPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useDeliveryLocation();
  const cart = useCart();
  const branchId = cart.data?.branch?.id ?? null;
  const addresses = useQuery({
    queryKey: ['addresses', branchId],
    queryFn: () => customer.addresses.list(branchId ?? undefined),
    enabled: Boolean(branchId),
  });

  const [addressId, setAddressId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState<PaymentMethodKind>('ONLINE');
  const [useWallet, setUseWallet] = useState(false);
  const [tip, setTip] = useState(0);
  const [contactless, setContactless] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [committedInstructions, setCommittedInstructions] = useState('');

  const [session, setSession] = useState<CheckoutSession | null>(null);
  const sessionRef = useRef<CheckoutSession | null>(null);
  const seq = useRef(0);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const idempotencyKey = useIdempotencyKey();

  // Pre-select the address chosen as the delivery location, else the default one.
  useEffect(() => {
    if (addressId || !addresses.data?.length) return;
    const list = addresses.data;
    const pick =
      list.find((a) => a.id === location?.addressId) ??
      list.find((a) => a.isDefault && a.serviceability?.serviceable !== false) ??
      list.find((a) => a.serviceability?.serviceable !== false) ??
      list[0];
    if (pick) setAddressId(pick.id);
  }, [addresses.data, addressId, location?.addressId]);

  const options: CheckoutOptionsBody | null = addressId
    ? {
        addressId,
        paymentMethod: method,
        useWallet: method === 'ONLINE' && useWallet,
        tipAmount: tip,
        contactless: method !== 'COD' && contactless,
        ...(committedInstructions ? { deliveryInstructions: committedInstructions } : {}),
      }
    : null;
  const optionsKey = options ? JSON.stringify(options) : null;

  /** Creates the session, or re-quotes it whenever an option changes (API-CHK-001/003). */
  const requote = useRef(async (_body: CheckoutOptionsBody) => {});
  requote.current = async (body: CheckoutOptionsBody) => {
    const mine = ++seq.current;
    setQuoting(true);
    setQuoteError(null);
    try {
      const current = sessionRef.current;
      let next: CheckoutSession;
      try {
        next =
          current && current.status === 'OPEN'
            ? await customer.checkout.update(current.id, body)
            : await customer.checkout.create(body);
      } catch (e) {
        if (
          current &&
          isApiClientError(e) &&
          ['CHECKOUT_SESSION_EXPIRED', 'CHECKOUT_SESSION_CONSUMED', 'NOT_FOUND'].includes(e.code)
        )
          next = await customer.checkout.create(body);
        else throw e;
      }
      if (mine === seq.current) {
        sessionRef.current = next;
        setSession(next);
      }
    } catch (e) {
      if (mine === seq.current) setQuoteError(e);
    } finally {
      if (mine === seq.current) setQuoting(false);
    }
  };
  useEffect(() => {
    if (optionsKey) void requote.current(JSON.parse(optionsKey) as CheckoutOptionsBody);
  }, [optionsKey]);

  const amount = session?.payableAmount ?? cart.data?.preview?.payable ?? 0;
  const methods = useQuery({
    queryKey: ['payment-methods', branchId, amount],
    queryFn: () => customer.checkout.methods(branchId!, amount),
    enabled: Boolean(branchId),
  });
  const wallet = methods.data?.find((m) => m.method === 'WALLET');

  async function place() {
    if (!session || !options) return;
    setPlacing(true);
    setPlaceError(null);
    setNotice(null);
    try {
      const key = idempotencyKey(`${session.id}:${session.version}:${session.payableAmount}`);
      const result = await customer.checkout.confirm(session.id, session.payableAmount, key);
      void qc.invalidateQueries({ queryKey: cartKey });
      if (result.order.status === 'PAYMENT_PENDING')
        navigate(`/orders/${result.order.id}/pay`, {
          state: { payment: result.payment, paymentError: result.paymentError },
        });
      else navigate(`/orders/${result.order.id}`, { state: { placed: true } });
    } catch (e) {
      if (isApiClientError(e)) {
        if (e.code === 'CHECKOUT_SESSION_CONSUMED') {
          const orderId = e.details.find((d) => d.code === 'ORDER_ID')?.message;
          if (orderId) {
            navigate(`/orders/${orderId}`);
            return;
          }
        }
        if (e.code === 'PRICE_CHANGED' || e.code === 'CHECKOUT_SESSION_EXPIRED') {
          setNotice(CONFIRM_TEXT[e.code]!);
          if (e.code === 'CHECKOUT_SESSION_EXPIRED') sessionRef.current = null;
          await requote.current(options);
          return;
        }
      }
      setPlaceError(e);
    } finally {
      setPlacing(false);
    }
  }

  if (cart.isPending)
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading checkout" />
      </div>
    );
  if (!cart.data?.branch || cart.data.lines.length === 0)
    return (
      <EmptyState
        title="Nothing to check out"
        action={
          <Link to="/" className="font-medium text-brand-700 underline">
            Browse restaurants
          </Link>
        }
      />
    );

  const confirmError =
    isApiClientError(placeError) && CONFIRM_TEXT[placeError.code]
      ? CONFIRM_TEXT[placeError.code]
      : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Checkout</h1>
        <p className="text-sm text-gray-600">{cart.data.branch.restaurantName}</p>
      </div>

      <Section
        title="Deliver to"
        aside={
          !adding && (
            <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
              Add address
            </Button>
          )
        }
      >
        {adding ? (
          <AddressForm
            initial={
              location ? { lat: location.lat, lng: location.lng, area: location.label } : null
            }
            onCancel={() => setAdding(false)}
            onSaved={(a) => {
              setAdding(false);
              setAddressId(a.id);
              void qc.invalidateQueries({ queryKey: ['addresses'] });
            }}
          />
        ) : addresses.isPending ? (
          <Spinner label="Loading addresses" />
        ) : addresses.data && addresses.data.length > 0 ? (
          <fieldset>
            <legend className="sr-only">Delivery address</legend>
            <div className="space-y-2">
              {addresses.data.map((a) => {
                const blocked = a.serviceability?.serviceable === false;
                return (
                  <label
                    key={a.id}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3',
                      addressId === a.id ? 'border-brand-700 bg-brand-50' : 'border-gray-200',
                      blocked && 'opacity-60',
                    )}
                  >
                    <input
                      type="radio"
                      name="address"
                      className="mt-1 h-5 w-5"
                      checked={addressId === a.id}
                      disabled={blocked}
                      onChange={() => setAddressId(a.id)}
                    />
                    <span className="text-sm">
                      <span className="block font-medium text-gray-900">
                        {a.customLabel ?? a.label[0] + a.label.slice(1).toLowerCase()}
                      </span>
                      <span className="block text-gray-600">
                        {a.line1}, {a.area}, {a.city} {a.pincode}
                      </span>
                      {blocked && (
                        <span className="block text-danger-600">
                          {SERVICEABILITY_TEXT[a.serviceability?.reason ?? 'OUTSIDE_RADIUS'] ??
                            'Not deliverable from this restaurant.'}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : (
          <p className="text-sm text-gray-600">Add an address to continue.</p>
        )}
        {session?.delivery && (
          <p className="mt-2 text-sm text-gray-700">
            Arrives in about {etaRange(session.delivery.eta)}
          </p>
        )}
        <label className="mt-3 block text-sm">
          <span className="font-medium text-gray-800">Delivery instructions (optional)</span>
          <textarea
            value={instructions}
            maxLength={200}
            rows={2}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => setCommittedInstructions(instructions.trim())}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base"
          />
        </label>
        <label className="mt-2 flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={contactless && method !== 'COD'}
            disabled={method === 'COD'}
            onChange={(e) => setContactless(e.target.checked)}
          />
          <span>
            Contactless delivery (leave at the door)
            {method === 'COD' && (
              <span className="block text-xs text-gray-500">Needs a prepaid order</span>
            )}
          </span>
        </label>
      </Section>

      <Section title="Tip your delivery partner">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Tip amount">
          {TIPS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tip === t}
              onClick={() => setTip(t)}
              className={cn(
                'h-11 rounded-full border px-4 text-sm font-medium',
                tip === t ? 'border-brand-700 bg-brand-50 text-brand-800' : 'border-gray-300',
              )}
            >
              {t === 0 ? 'No tip' : rupees(t)}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-500">The whole tip goes to your delivery partner.</p>
      </Section>

      <Section title="Payment">
        <fieldset>
          <legend className="sr-only">Payment method</legend>
          <div className="space-y-2">
            {(['ONLINE', 'COD', 'WALLET'] as const).map((m) => {
              const option = methods.data?.find((o) => o.method === m);
              const available = option ? option.available : m === 'ONLINE';
              return (
                <label
                  key={m}
                  className={cn(
                    'flex min-h-11 items-start gap-3 rounded-lg border p-3',
                    method === m ? 'border-brand-700 bg-brand-50' : 'border-gray-200',
                    !available && 'opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="method"
                    className="mt-1 h-5 w-5"
                    checked={method === m}
                    disabled={!available}
                    onChange={() => setMethod(m)}
                  />
                  <span className="text-sm">
                    <span className="block font-medium text-gray-900">
                      {METHOD_LABEL[m]}
                      {m === 'WALLET' && option?.balance != null && ` (${rupees(option.balance)})`}
                    </span>
                    {!available && option?.reason && (
                      <span className="block text-gray-600">{option.reason}</span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {method === 'ONLINE' && wallet?.balance ? (
          <label className="mt-2 flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={useWallet}
              onChange={(e) => setUseWallet(e.target.checked)}
            />
            Use wallet balance ({rupees(wallet.balance)}) and pay the rest online
          </label>
        ) : null}
      </Section>

      <Section title="Bill details" aside={quoting && <Spinner label="Updating total" />}>
        <div aria-live="polite" className="space-y-2">
          {notice && <Alert tone="warning">{notice}</Alert>}
          <ServerError error={quoteError} />
        </div>
        {session ? (
          <PriceBreakdown quote={session.quote} />
        ) : (
          !quoteError && (
            <p className="text-sm text-gray-600">Choose an address to see the total.</p>
          )
        )}
      </Section>

      <div aria-live="assertive">
        {confirmError ? (
          <Alert tone="error" title={confirmError}>
            {isApiClientError(placeError) && placeError.code === 'CART_CHANGED' && (
              <Link to="/cart" className="text-brand-700 underline">
                Review cart
              </Link>
            )}
          </Alert>
        ) : (
          <ServerError error={placeError} />
        )}
      </div>

      <div className="sticky bottom-0 -mx-4 border-t border-gray-200 bg-white px-4 py-3">
        <Button
          size="lg"
          className="w-full"
          loading={placing}
          disabled={!session || quoting || Boolean(quoteError) || session.status !== 'OPEN'}
          onClick={() => void place()}
        >
          {session
            ? method === 'ONLINE' && session.payableAmount > 0
              ? `Place order & pay ${rupees(session.payableAmount)}`
              : `Place order · ${rupees(session.payableAmount)}`
            : 'Place order'}
        </Button>
      </div>
    </div>
  );
}
