import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { isApiClientError, type MockPaymentScenario, type PaymentInit } from '@fos/api-client';
import { Alert, Button, ErrorState, Spinner } from '@fos/ui';
import { Section, Select, ServerError } from '../components/ui';
import { customer } from '../lib/customer';
import { rupees } from '../lib/format';
import { useIdempotencyKey } from '../lib/idempotency';

const SCENARIOS: { value: MockPaymentScenario; label: string }[] = [
  { value: 'success', label: 'Payment succeeds' },
  { value: 'fail', label: 'Payment fails' },
];

/**
 * Online payment step (UI §17.1.1 Payment). Locally the API runs the mock provider:
 * its dev-only `mock-checkout` stands in for the hosted checkout and returns the
 * provider's payment id and signature, which are then verified exactly as a real
 * checkout's would be (API-PAY-003). Success is decided by the server only.
 */
export function PaymentPage() {
  const { orderId = '' } = useParams();
  const navigate = useNavigate();
  const state = useLocation().state as {
    payment?: PaymentInit | null;
    paymentError?: string | null;
  } | null;
  const [payment, setPayment] = useState<PaymentInit | null>(state?.payment ?? null);
  const [scenario, setScenario] = useState<MockPaymentScenario>('success');
  const [phase, setPhase] = useState<'idle' | 'paying' | 'confirming'>('idle');
  const [error, setError] = useState<unknown>(
    state?.paymentError ? new Error('We couldn’t start the payment. Please try again.') : null,
  );
  const [failed, setFailed] = useState<string | null>(null);
  const attempt = useRef(0);
  const idempotencyKey = useIdempotencyKey();
  const verifyKey = useIdempotencyKey();
  const cancelKey = useIdempotencyKey();
  const [cancelling, setCancelling] = useState(false);

  const order = useQuery({
    queryKey: ['order', orderId, 'details'],
    queryFn: () => customer.orders.details(orderId),
  });

  async function pay() {
    setError(null);
    setFailed(null);
    setPhase('paying');
    try {
      let current = payment;
      if (!current) {
        current = await customer.payments.initiate(
          orderId,
          idempotencyKey(`initiate:${orderId}:${attempt.current}`),
        );
        setPayment(current);
      }
      let proof: { providerPaymentId: string; signature: string };
      try {
        proof = await customer.payments.mockCheckout(current.paymentId, scenario);
      } catch (e) {
        if (isApiClientError(e) && e.status === 404)
          throw new Error('Online payment isn’t available in this environment yet.');
        throw e;
      }
      setPhase('confirming');
      const verified = await customer.payments.verify(
        current.paymentId,
        proof,
        verifyKey(`${current.paymentId}:${proof.providerPaymentId}`),
      );
      if (verified.status === 'CAPTURED' || verified.status === 'AUTHORIZED') {
        navigate(`/orders/${orderId}`, { replace: true, state: { placed: true } });
        return;
      }
      setFailed(verified.failureReason ?? 'Your payment didn’t go through.');
      // A retry is a new attempt (FR-PAY-005).
      attempt.current += 1;
      setPayment(null);
    } catch (e) {
      if (isApiClientError(e) && e.code.startsWith('PAYMENT_')) {
        attempt.current += 1;
        setPayment(null);
      }
      setError(e);
    } finally {
      setPhase('idle');
    }
  }

  async function cancel() {
    if (!payment) return;
    setCancelling(true);
    setError(null);
    try {
      await customer.payments.cancel(payment.paymentId, cancelKey(payment.paymentId));
      navigate(`/orders/${orderId}`, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setCancelling(false);
    }
  }

  if (order.isPending)
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading payment" />
      </div>
    );
  if (order.isError)
    return <ErrorState title="Couldn’t load this order" description={order.error.message} />;
  const o = order.data;
  if (o.status !== 'PAYMENT_PENDING')
    return (
      <Alert tone="info" title={`Order ${o.number}: ${o.statusLabel}`}>
        <Link to={`/orders/${orderId}`} className="text-brand-700 underline">
          View order
        </Link>
      </Alert>
    );

  const amount = payment?.amount ?? o.breakdown.payable;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Complete payment</h1>
      <Section title={`Order ${o.number}`}>
        <p className="text-sm text-gray-700">{o.restaurant.name}</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">{rupees(amount)}</p>
        <p className="mt-1 text-xs text-gray-500">
          Your order is sent to the restaurant once the payment is confirmed.
        </p>
      </Section>

      <Section title="Test checkout">
        <p className="mb-2 text-sm text-gray-600">
          This environment uses a test payment provider; no money moves.
        </p>
        <Select
          label="Test payment outcome"
          value={scenario}
          onChange={(e) => setScenario(e.target.value as MockPaymentScenario)}
        >
          {SCENARIOS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Section>

      <div aria-live="polite" className="space-y-2">
        {phase === 'confirming' && <Alert tone="info">Confirming your payment…</Alert>}
        {failed && (
          <Alert tone="error" title="Payment failed">
            {sentence(failed)} You can try again.
          </Alert>
        )}
        <ServerError error={error} />
      </div>

      <Button size="lg" className="w-full" loading={phase !== 'idle'} onClick={() => void pay()}>
        {failed || error ? `Try again · ${rupees(amount)}` : `Pay ${rupees(amount)}`}
      </Button>
      {payment && (
        <Button
          variant="ghost"
          className="w-full"
          loading={cancelling}
          disabled={phase !== 'idle'}
          onClick={() => void cancel()}
        >
          Cancel order
        </Button>
      )}
    </div>
  );
}

/** Provider messages may or may not end with a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
