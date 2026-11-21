// Menu loads (API-MENU-001, NFR-PERF-004): mostly cache hits on popular branches.
//   k6 run -e BASE_URL=https://staging.example.com tests/load/menu.js
import { check, fail, sleep } from 'k6';
import { data, get, POINTS } from './lib/common.js';

export const options = {
  scenarios: {
    menus: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 200), // menu loads per second
      timeUnit: '1s',
      duration: __ENV.DURATION || '10m',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    // NFR-PERF-004 peak: cache hit ≤ 150 ms, miss ≤ 600 ms. Steady traffic is almost all
    // hits (the menu cache is keyed by branch and menu version), so p95 must meet the hit target.
    'http_req_duration{name:menu}': ['p(95)<150', 'p(99)<600'],
    http_req_failed: ['rate<0.01'],
  },
};

/** Branch ids from discovery around the pilot points, shared by every VU. */
export function setup() {
  const ids = new Set();
  for (const p of POINTS) {
    const list =
      data(get(`/discovery/restaurants?lat=${p.lat}&lng=${p.lng}`, { name: 'setup' })) || [];
    for (const r of list) if (r.branchId) ids.add(r.branchId);
  }
  if (!ids.size) fail('no branches found near the pilot points; is the stack seeded?');
  return { branches: [...ids] };
}

export default function ({ branches }) {
  // Zipf-like popularity: a few branches take most of the traffic.
  const i = Math.min(branches.length - 1, Math.floor(branches.length * Math.random() ** 3));
  check(get(`/branches/${branches[i]}/menu`, { name: 'menu' }), {
    'menu 200': (r) => r.status === 200,
  });
  sleep(0.1);
}
