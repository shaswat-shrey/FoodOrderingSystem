// Real-time fan-out (NFR-PERF-008): idle customer sockets load the gateway while
// "probe" customers place an order, subscribe to it, and time the push that follows
// the restaurant's acceptance (commit → client).
//   k6 run -e BASE_URL=https://staging.example.com -e CUSTOMERS_FILE=customers.json \
//          -e STAFF_PHONE=… -e STAFF_PASSWORD=… -e BRANCH_ID=… tests/load/sockets.js
import { check, fail, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { accountFor, accounts, data, get, send, signIn } from './lib/common.js';
import { connect } from './lib/socketio.js';

const commitToClient = new Trend('rt_commit_to_client_ms', true);
const acceptToClient = new Trend('rt_accept_to_client_ms', true);
const missed = new Counter('rt_events_missed');

export const options = {
  scenarios: {
    // Connected, subscribed customers (peak: thousands of sessions on the gateway).
    idle: {
      executor: 'constant-vus',
      exec: 'idle',
      vus: Number(__ENV.IDLE_SOCKETS || 1000),
      duration: __ENV.DURATION || '10m',
    },
    // Orders whose status pushes are timed.
    probe: {
      executor: 'constant-arrival-rate',
      exec: 'probe',
      rate: Number(__ENV.PROBES_PER_MIN || 20),
      timeUnit: '1m',
      duration: __ENV.DURATION || '10m',
      preAllocatedVUs: 10,
      maxVUs: 40,
    },
  },
  thresholds: {
    rt_commit_to_client_ms: ['p(95)<2000'], // NFR-PERF-008 peak (order/delivery events)
    rt_accept_to_client_ms: ['p(95)<3000'],
    rt_events_missed: ['count<5'],
    ws_connecting: ['p(95)<1000'],
    'checks{step:socket}': ['rate>0.99'],
  },
};

const CUSTOMERS = accounts('CUSTOMERS_FILE', [
  { phone: __ENV.CUSTOMER_PHONE || '+919000000101', password: __ENV.CUSTOMER_PASSWORD || '' },
]);
const STAFF = { phone: __ENV.STAFF_PHONE || '+919000000301', password: __ENV.STAFF_PASSWORD || '' };

export function setup() {
  const branchId = __ENV.BRANCH_ID;
  if (!branchId) fail('set BRANCH_ID to a branch the STAFF account manages');
  const menu = data(get(`/branches/${branchId}/menu`, { name: 'setup' }));
  const dish = (menu?.categories || [])
    .flatMap((c) => c.items || [])
    .find((i) => i.available && !i.customizable);
  if (!dish) fail('the branch has no orderable dish without choices');
  return { branchId, foodItemId: dish.id };
}

export function idle() {
  const token = signIn('CUSTOMER', accountFor(CUSTOMERS));
  const res = connect('CUSTOMER', token, {
    timeoutMs: 5 * 60_000,
    onReady: (io) => io.on('*', () => undefined),
  });
  check(res, { 'socket opened': (r) => r && r.status === 101 }, { step: 'socket' });
  sleep(1);
}

const staff = { token: null, at: 0 };
function staffToken() {
  // Access tokens live 15 minutes; renew well before.
  if (!staff.token || Date.now() - staff.at > 10 * 60_000) {
    staff.token = signIn('RESTAURANT', STAFF);
    staff.at = Date.now();
  }
  return staff.token;
}

export function probe({ branchId, foodItemId }) {
  const token = signIn('CUSTOMER', accountFor(CUSTOMERS));
  const addresses = data(get('/me/addresses', { token, name: 'addresses.list' })) || [];
  if (!addresses.length) return;
  send('DELETE', '/cart', undefined, { token, name: 'cart.clear' });
  send(
    'POST',
    '/cart/items',
    { branchId, foodItemId, optionIds: [], quantity: 1 },
    { token, name: 'cart.add' },
  );
  const quote = data(
    send(
      'POST',
      '/checkout/sessions',
      { addressId: addresses[0].id, paymentMethod: 'COD', useWallet: false, tipAmount: 0 },
      { token, name: 'checkout.create' },
    ),
  );
  if (!quote) return;
  const order = data(
    send(
      'POST',
      `/checkout/sessions/${quote.id}/confirm`,
      { expectedPayable: quote.payableAmount },
      { token, name: 'checkout.confirm', idempotent: true },
    ),
  )?.order;
  if (!order) return;

  let acceptedAt = 0;
  let received = false;
  connect('CUSTOMER', token, {
    timeoutMs: 15_000,
    onReady: (io) => {
      io.on('order.status_changed', (env) => {
        if (env?.data?.to !== 'ACCEPTED' || received) return;
        received = true;
        const now = Date.now();
        commitToClient.add(now - Date.parse(env.occurredAt));
        acceptToClient.add(now - acceptedAt);
        io.close();
      });
      io.emit('subscribe', { type: 'order', id: order.id }, (ack) => {
        check(ack, { subscribed: (a) => a && a.ok }, { step: 'socket' });
        acceptedAt = Date.now();
        send(
          'POST',
          `/merchant/orders/${order.id}/accept`,
          { prepMinutes: 15 },
          { app: 'RESTAURANT', token: staffToken(), name: 'merchant.accept', idempotent: true },
        );
      });
    },
  });
  if (!received) missed.add(1);
}
