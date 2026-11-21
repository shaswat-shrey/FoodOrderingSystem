# Load tests (`tests/load`)

[k6](https://k6.io) scripts for the performance targets in
[NON-FUNCTIONAL-REQUIREMENTS.md](../../docs/requirements/NON-FUNCTIONAL-REQUIREMENTS.md)
(NFR-PERF-001…013, AC-NFR-001). They run against a **staging** stack, never production
and never a developer laptop sharing the database with other work. Thresholds use the
**peak** column; a run that misses one exits non-zero.

| Script         | Load                                                                           | Thresholds (p95, peak)                                                              |
| -------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `discovery.js` | ramp to `PEAK_VUS` (600) browsing users: home, listing, typeahead, search      | listing ≤ 800 ms, home ≤ 800 ms, suggestions ≤ 300 ms, full search ≤ 700 ms         |
| `menu.js`      | `RATE` (200) menu loads/s, skewed to popular branches                          | menu ≤ 150 ms (cache hit), p99 ≤ 600 ms (miss)                                      |
| `checkout.js`  | `ORDERS_PER_MIN` (60) COD orders: cart, checkout session, confirm              | add to cart ≤ 600 ms, checkout ≤ 1 s, confirm ≤ 1.5 s                               |
| `location.js`  | `PARTNER_VUS` partners online, one fix every `PERIOD` (5) s                    | ingestion ≤ 300 ms (p99 ≤ 600 ms); watch API CPU < 50 % at 200 fixes/s per instance |
| `sockets.js`   | `IDLE_SOCKETS` (1000) connected customers + `PROBES_PER_MIN` (20) timed orders | acceptance push commit → client ≤ 2 s; WebSocket connect ≤ 1 s                      |
| `smoke.mjs`    | Node only (no k6): N concurrent public reads                                   | p95 ≤ `--p95` (800 ms)                                                              |

All scripts check `http_req_failed` (< 1–2 %). Latencies are measured at the client, so
run k6 in the same region (ideally the same network) as the API; the NFR targets are
server time.

## Before a run

1. **Stack**: staging deployed with the API, worker, PostgreSQL and Redis sized like
   production, the development seed (pilot zone, restaurants, menus) and restaurants open
   for the whole run. Scale API instances as you would in production and record how many.
2. **Accounts** (the scripts sign in with passwords; they never create users):
   - `customers.json`: `[{ "phone": "+91…", "password": "…" }, …]`, at least one per VU of
     `checkout.js`/`sockets.js` (e.g. 200), phone-verified, each with a saved address inside
     the pilot zone (`checkout.js` creates one when missing).
   - `partners.json`: approved, active partners (500 for the peak profile), COD enabled.
   - One restaurant manager (`STAFF_PHONE`/`STAFF_PASSWORD`) of `BRANCH_ID` for `sockets.js`.
     Provision them with a one-off script against staging (or the admin console); keep the
     files out of git.
3. **Rate limits**: the per-IP sign-in and per-user limits (BR-AUTH-004, §14.1) apply. Run
   k6 from several IPs or raise the limits on staging for the run, and say so in the report.
4. **Side effects**: `checkout.js` and `sockets.js` place real (COD) orders and `sockets.js`
   accepts them; partners from `location.js` stay online. Cancel or let the order timers
   expire the orders afterwards; take partners offline from the admin console.

## Running

```bash
# Install k6 (and xk6 only if you prefer xk6-websockets; sockets.js uses the built-in k6/ws).
export BASE_URL=https://staging.example.com
export ORIGIN_CUSTOMER=https://staging-app.example.com   # origins the API allows
export ORIGIN_RESTAURANT=https://staging-restaurant.example.com
export ORIGIN_DELIVERY=https://staging-partner.example.com

k6 run tests/load/discovery.js
k6 run tests/load/menu.js
k6 run -e CUSTOMERS_FILE=./customers.json tests/load/checkout.js
k6 run -e PARTNERS_FILE=./partners.json tests/load/location.js
k6 run -e CUSTOMERS_FILE=./customers.json -e STAFF_PHONE=+91… -e STAFF_PASSWORD=… \
       -e BRANCH_ID=… tests/load/sockets.js

# The full peak profile (AC-NFR-001): run discovery, menu, checkout, location and sockets
# together, each from its own k6 instance, for at least 15 minutes.

# Quick smoke without k6 (any environment with Node 22+):
node tests/load/smoke.mjs --base http://localhost:4000 --concurrency 20 --requests 400
```

Useful overrides: `DURATION`, `PEAK_VUS`, `HOLD`, `RATE`, `ORDERS_PER_MIN`, `PARTNER_VUS`,
`PERIOD`, `IDLE_SOCKETS`, `PROBES_PER_MIN`. Export results with `--summary-export` or an
output (`-o json=…`, Prometheus remote write) and attach them to the release notes.

## What to watch besides the thresholds

- API and worker CPU and memory, event-loop lag, PostgreSQL connections and slow queries
  (NFR-PERF-012: no P0 query above 100 ms p95), Redis memory and latency.
- Dispatch: order dispatchable → first offer (NFR-PERF-009) from `delivery_assignments`
  (`offered_at` − `deliveries.dispatch_starts_at`) for the orders placed during the run.
- Outbox lag (`outbox_events.published_at − created_at`) and the ops alerts page.
