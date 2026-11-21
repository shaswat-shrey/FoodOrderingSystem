// Cart → checkout → order placement at the dinner peak (NFR-PERF-006, 007; 60 orders/min).
//   k6 run -e BASE_URL=https://staging.example.com -e CUSTOMERS_FILE=customers.json tests/load/checkout.js
// Every order is cash on delivery, so no payment provider is involved.
import { check, fail, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { accountFor, accounts, data, get, POINTS, send, signIn } from './lib/common.js';

const placed = new Trend('order_placement_ms', true);

export const options = {
  scenarios: {
    orders: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.ORDERS_PER_MIN || 60),
      timeUnit: '1m',
      duration: __ENV.DURATION || '15m',
      preAllocatedVUs: 20,
      maxVUs: 120,
    },
  },
  thresholds: {
    'http_req_duration{name:cart.add}': ['p(95)<600'], // NFR-PERF-002 peak
    'http_req_duration{name:checkout.create}': ['p(95)<1000'], // NFR-PERF-006 peak
    'http_req_duration{name:checkout.confirm}': ['p(95)<1500'], // NFR-PERF-007 peak
    order_placement_ms: ['p(95)<3000'],
    'checks{step:confirm}': ['rate>0.98'],
    http_req_failed: ['rate<0.02'],
  },
};

const CUSTOMERS = accounts('CUSTOMERS_FILE', [
  { phone: __ENV.CUSTOMER_PHONE || '+919000000101', password: __ENV.CUSTOMER_PASSWORD || '' },
]);

/** Orderable dishes without required choices, from open branches near the pilot point. */
export function setup() {
  const p = POINTS[0];
  const list =
    data(get(`/discovery/restaurants?lat=${p.lat}&lng=${p.lng}`, { name: 'setup' })) || [];
  const dishes = [];
  for (const r of list.slice(0, 15)) {
    const menu = data(get(`/branches/${r.branchId}/menu`, { name: 'setup' }));
    for (const c of menu?.categories || [])
      for (const i of c.items || [])
        if (i.available && !i.customizable) dishes.push({ branchId: r.branchId, foodItemId: i.id });
  }
  if (!dishes.length) fail('no orderable dishes near the pilot point; are restaurants open?');
  return { dishes };
}

const sessions = {};

function session() {
  const account = accountFor(CUSTOMERS);
  if (!sessions[account.phone]) {
    const token = signIn('CUSTOMER', account);
    let addresses = data(get('/me/addresses', { token, name: 'addresses.list' })) || [];
    if (!addresses.length) {
      const created = send(
        'POST',
        '/me/addresses',
        {
          label: 'HOME',
          line1: 'Load test flat',
          area: 'Koramangala',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560095',
          location: POINTS[0],
        },
        { token, name: 'addresses.create' },
      );
      addresses = [data(created)];
    }
    sessions[account.phone] = { token, addressId: addresses[0].id };
  }
  return sessions[account.phone];
}

export default function ({ dishes }) {
  const { token, addressId } = session();
  const dish = dishes[Math.floor(Math.random() * dishes.length)];
  const started = Date.now();

  send('DELETE', '/cart', undefined, { token, name: 'cart.clear' });
  const added = send(
    'POST',
    '/cart/items',
    { branchId: dish.branchId, foodItemId: dish.foodItemId, optionIds: [], quantity: 1 },
    { token, name: 'cart.add' },
  );
  if (!check(added, { 'added to cart': (r) => r.status < 300 }, { step: 'cart' })) return;
  sleep(1);

  const s = send(
    'POST',
    '/checkout/sessions',
    { addressId, paymentMethod: 'COD', useWallet: false, tipAmount: 0 },
    { token, name: 'checkout.create' },
  );
  const quote = data(s);
  if (!check(s, { quoted: (r) => r.status < 300 && Boolean(quote) }, { step: 'quote' })) return;
  sleep(1);

  const confirmed = send(
    'POST',
    `/checkout/sessions/${quote.id}/confirm`,
    { expectedPayable: quote.payableAmount },
    { token, name: 'checkout.confirm', idempotent: true },
  );
  if (check(confirmed, { 'order placed': (r) => r.status === 201 }, { step: 'confirm' }))
    placed.add(Date.now() - started - 2000);
}
