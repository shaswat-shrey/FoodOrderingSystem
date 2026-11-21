// Discovery and search under the dinner-peak browsing load (NFR-PERF-003, 005).
//   k6 run -e BASE_URL=https://staging.example.com tests/load/discovery.js
import { check, sleep } from 'k6';
import { get, pick, POINTS, SEARCH_TERMS } from './lib/common.js';

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: Number(__ENV.PEAK_VUS || 600) },
        {
          duration: Number(__ENV.HOLD || 0) ? __ENV.HOLD : '10m',
          target: Number(__ENV.PEAK_VUS || 600),
        },
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Peak column of NFR-PERF-003 and 005 (server time; run close to the API).
    'http_req_duration{name:discovery.list}': ['p(95)<800'],
    'http_req_duration{name:search.suggestions}': ['p(95)<300'],
    'http_req_duration{name:search.full}': ['p(95)<700'],
    'http_req_duration{name:discovery.home}': ['p(95)<800'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const p = pick(POINTS);
  const at = `lat=${p.lat}&lng=${p.lng}`;
  check(get(`/discovery/home?${at}`, { name: 'discovery.home' }), {
    'home 200': (r) => r.status === 200,
  });
  check(get(`/discovery/restaurants?${at}`, { name: 'discovery.list' }), {
    'list 200': (r) => r.status === 200,
  });
  sleep(1 + Math.random() * 2);
  const term = pick(SEARCH_TERMS);
  // Autocomplete as the user types, then the full search.
  for (const n of [2, 4, term.length]) {
    check(get(`/search/suggestions?q=${term.slice(0, n)}&${at}`, { name: 'search.suggestions' }), {
      'suggestions 200': (r) => r.status === 200,
    });
    sleep(0.3);
  }
  check(get(`/search?q=${term}&${at}`, { name: 'search.full' }), {
    'search 200': (r) => r.status === 200,
  });
  sleep(2 + Math.random() * 3);
}
