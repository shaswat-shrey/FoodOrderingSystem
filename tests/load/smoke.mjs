// Dependency-free smoke load for a local or staging stack (Node 22+, no k6 needed):
// a fixed number of concurrent GETs against the public read paths, reporting p50/p95/p99
// and failing (exit 1) when p95 exceeds the NFR-PERF-003 peak target.
//   node tests/load/smoke.mjs --base http://localhost:4000 --concurrency 20 --requests 400
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
const base = (args.base ?? process.env.BASE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const concurrency = Number(args.concurrency ?? 20);
const total = Number(args.requests ?? 400);
const p95Limit = Number(args.p95 ?? 800);
const at = 'lat=12.9352&lng=77.6245';
const paths = [
  `/api/v1/discovery/restaurants?${at}`,
  `/api/v1/discovery/home?${at}`,
  `/api/v1/search/suggestions?q=bir&${at}`,
  `/api/v1/search?q=biryani&${at}`,
];

const times = [];
let failures = 0;
let next = 0;

async function worker() {
  while (next < total) {
    const path = paths[next++ % paths.length];
    const started = performance.now();
    try {
      const res = await fetch(`${base}${path}`, { headers: { 'X-Client-App': 'CUSTOMER' } });
      await res.arrayBuffer();
      if (!res.ok) failures++;
    } catch {
      failures++;
    }
    times.push(performance.now() - started);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
times.sort((a, b) => a - b);
const pct = (p) =>
  times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))].toFixed(1);
const summary = { requests: times.length, failures, p50: pct(50), p95: pct(95), p99: pct(99) };
console.log(JSON.stringify(summary));
if (failures > 0 || Number(summary.p95) > p95Limit) process.exit(1);
