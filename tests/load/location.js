// Partner location ingestion (NFR-PERF-013: 200 updates/s per API instance; peak 100/s
// from 500 partners). Partners go online once, then send one fix every PERIOD seconds.
//   k6 run -e BASE_URL=https://staging.example.com -e PARTNERS_FILE=partners.json tests/load/location.js
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { accountFor, accounts, POINTS, send, signIn } from './lib/common.js';

const PERIOD = Number(__ENV.PERIOD || 5); // seconds between fixes per partner
const PARTNERS = accounts('PARTNERS_FILE', [
  { phone: __ENV.PARTNER_PHONE || '+919000000401', password: __ENV.PARTNER_PASSWORD || '' },
]);

export const options = {
  scenarios: {
    partners: {
      executor: 'constant-vus',
      vus: Number(__ENV.PARTNER_VUS || Math.min(PARTNERS.length, 1000)),
      duration: __ENV.DURATION || '10m',
    },
  },
  thresholds: {
    'http_req_duration{name:partner.locations}': ['p(95)<300', 'p(99)<600'], // NFR-PERF-002
    'checks{step:fix}': ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
  },
};

const state = {};

export default function () {
  const account = accountFor(PARTNERS);
  let s = state[account.phone];
  const origin = POINTS[(exec.vu.idInTest - 1) % POINTS.length];
  if (!s) {
    const token = signIn('DELIVERY', account);
    s = state[account.phone] = { token, lat: origin.lat, lng: origin.lng };
    send(
      'POST',
      '/partner/me/online',
      { lat: s.lat, lng: s.lng, accuracyM: 10, recordedAt: new Date().toISOString() },
      { app: 'DELIVERY', token, name: 'partner.online', idempotent: true },
    );
  }
  // Drift ~10–20 m per fix, like a rider in traffic.
  s.lat += (Math.random() - 0.5) * 0.0003;
  s.lng += (Math.random() - 0.5) * 0.0003;
  const res = send(
    'POST',
    '/partner/me/locations',
    {
      points: [
        {
          lat: s.lat,
          lng: s.lng,
          accuracyM: 8 + Math.random() * 10,
          recordedAt: new Date().toISOString(),
        },
      ],
    },
    { app: 'DELIVERY', token: s.token, name: 'partner.locations' },
  );
  check(res, { 'fix accepted': (r) => r.status === 200 }, { step: 'fix' });
  sleep(PERIOD);
}

export function teardown() {
  // Partners stay online after the run; take them offline from the admin console or let
  // the inactivity sweep do it (FR-DP-013).
}
