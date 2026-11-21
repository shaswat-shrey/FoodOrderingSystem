# Deployment guide

How to run FoodOrderSystem in staging and production. It complements [SYSTEM-ARCHITECTURE.md](../architecture/SYSTEM-ARCHITECTURE.md) §2, §9 and §13 and the [environment reference](ENVIRONMENT.md).

> **Read first — the MVP cannot go live as built.** The worker refuses to start with `NODE_ENV=production` because no SMS or email provider is integrated (OTPs and emailed codes only reach the development log), and the customer app has no Razorpay Checkout integration (only the development mock checkout). Until then a staging stack for demos and load tests runs the production images with `NODE_ENV=development` (mock payments, file or log message sink, HTTPS still terminated at the edge with `COOKIE_SECURE=true`); never put real users on it. See the [go-live checklist](#12-go-live-checklist) and [KNOWN-LIMITATIONS.md](../KNOWN-LIMITATIONS.md).

## 1. What gets deployed

| Component | Artifact | Runs as |
| --- | --- | --- |
| API | `infrastructure/docker/api.Dockerfile` → image with `dist/server.js` | N stateless containers on port 4000 (REST + Socket.IO + webhooks) |
| Worker | `infrastructure/docker/worker.Dockerfile` → image with `dist/main.js` | 1+ containers; health on 4001 |
| Migrations | the API image + the Prisma CLI, or a CI job with the repository | One-off job before each rollout |
| Customer, restaurant, delivery, admin apps | `pnpm --filter @fos/<app>-web build` → `apps/<app>-web/dist/` (static files) | Nginx or a CDN/object store, one hostname per app |
| PostgreSQL 16+ with PostGIS | managed service | primary + PITR backups (+ read replica later) |
| Redis core | managed, HA, `noeviction`, persistence | queues, locks, sessions, rate limits, socket adapter, live partner state |
| Redis cache | managed or a separate database, `allkeys-lru` | disposable cache |
| Object storage | S3 / Cloudflare R2 (two buckets) | public media (through a CDN) and private documents |

### Building images

Both Dockerfiles build from the repository root, use `node:22-alpine`, install with the frozen lockfile, bundle with tsup, `pnpm deploy --prod` the package, generate the Prisma client inside the image and run as a non-root user with `NODE_ENV=production`:

```bash
docker build -f infrastructure/docker/api.Dockerfile -t fos-api:$(git rev-parse --short HEAD) .
docker build -f infrastructure/docker/worker.Dockerfile -t fos-worker:$(git rev-parse --short HEAD) .
```

Tag images with the commit, push to your registry and deploy the same tag to staging and production. Run containers with a read-only root filesystem where the platform allows it (the API writes nothing to disk with the S3 driver).

### Building the web apps

```bash
pnpm install --frozen-lockfile
pnpm --filter @fos/customer-web --filter @fos/restaurant-web --filter @fos/delivery-web --filter @fos/admin-web build
```

The apps have no build-time configuration: they call `/api/v1` and `/socket.io` on their own origin, so the same build works in every environment. Files under `dist/assets/` are content-hashed (cache them for a year); `index.html` must not be cached.

## 2. Database migrations and seed policy

- Apply migrations with Prisma's deploy command only — never `migrate dev`, `db push` or `migrate reset` against a shared database:

  ```bash
  DATABASE_URL=… pnpm --filter @fos/db db:deploy      # prisma migrate deploy --schema prisma/schema
  pnpm --filter @fos/db db:status                     # what is applied
  ```

  Run it as a one-off job (from CI with the repository checked out, or a small migration image) **before** rolling out API and worker images that need the new schema. The database role used for migrations needs `CREATE` on the schema; the extensions (`postgis`, `pg_trgm`, `unaccent`, `citext`, `pgcrypto`) must be allowed by the managed service (create them once as an administrator if the migration role can't).

- Migrations are forward-only. Write them backward compatible (expand → deploy code → contract in a later release) so the previous release keeps working during a rollout and after a rollback.
- **No demo data in production.** `db:seed` truncates every table and loads fictional data; it refuses to run with `NODE_ENV=production`. Production starts empty; the reference data an operator must create before launch is listed in §12.
- The integration and E2E suites refuse databases whose names don't end in `_test` / `_e2e`; never point `TEST_DATABASE_URL` or `E2E_DATABASE_URL` at production.

## 3. Process model

### API (N instances)

- Stateless: sessions, rate limits, idempotency keys and socket fan-out live in Redis and PostgreSQL. Scale horizontally behind the proxy; no sticky sessions are needed because the shared socket client connects with **WebSocket only** (`transports: ['websocket']`). If a client ever enables long-polling, enable sticky sessions (cookie or IP hash) on `/socket.io` — polling requests must reach the instance that holds the session.
- Socket.IO uses the Redis adapter on the core Redis; realtime events produced by the worker arrive on the `rt:events` channel and each instance emits to its own sockets.
- Graceful shutdown on `SIGTERM`/`SIGINT`: close sockets and the HTTP server, then queues, PostgreSQL and Redis, with a forced exit after 25 s. Give containers ≥ 30 s termination grace.

### Worker

- **Correct with more than one instance**, but every instance runs every queue, so scale for throughput, not for safety:
  - the **outbox relay** runs on one instance at a time under a Redis leader lock (`outbox:relay:leader`, 15 s TTL); others take over within the TTL when the leader dies;
  - **repeatable jobs** (sweeps, ledger verification, cleanup) are BullMQ job schedulers registered idempotently at boot, so they run once per interval regardless of instance count;
  - **dispatch** is single-flight per delivery (Redis lock) and acceptance is exactly-once through row locks;
  - per-instance concurrency: maintenance 1, orders 10, dispatch 20, payments 10, refunds 5, notifications 20.
- Start with **one worker** (plus one standby or a fast restart policy) for the pilot; add instances when queue latency grows.
- A watchdog raises the `REDIS_UNAVAILABLE` ops alert while the core Redis is unreachable and clears it on recovery; dispatch pauses meanwhile.
- The worker has no public port; expose 4001 to the orchestrator only.

### Web apps

Static files only. Each app is a single-page app: unknown paths must fall back to `index.html`.

## 4. Edge: Nginx reference configuration

One hostname per app, each serving its static build **and** proxying `/api/` and `/socket.io/` to the API pool, so that every app talks to the API on its own origin (this is what the dev servers do, and what the per-app `Origin` checks expect). The API keeps its own strict headers (`default-src 'none'` CSP, frame denial, HSTS); the headers below are for the HTML apps.

```nginx
# /etc/nginx/conf.d/fos.conf — adapt hostnames, certificates and paths.

upstream fos_api {
    least_conn;
    server api-1:4000 max_fails=3 fail_timeout=10s;
    server api-2:4000 max_fails=3 fail_timeout=10s;
    keepalive 64;
}

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      '';
}

# Requests per IP at the edge (the API applies its own per-user and per-route limits).
limit_req_zone $binary_remote_addr zone=fos_api:20m rate=30r/s;

server {
    listen 80 default_server;
    server_name _;
    return 301 https://$host$request_uri;
}

# --- Shared pieces (included by every app server) -------------------------------
# /etc/nginx/snippets/fos-proxy.conf
#
#   client_max_body_size 11m;   # uploads are at most 10 MB (per-purpose limits in the API)
#
#   location /api/ {
#       limit_req zone=fos_api burst=60 nodelay;
#       proxy_pass http://fos_api;
#       proxy_http_version 1.1;
#       proxy_set_header Connection "";
#       proxy_set_header Host $host;
#       # Exactly one trusted hop: the API runs with trust proxy = 1 and takes the client
#       # IP from the last X-Forwarded-For entry, so overwrite whatever the client sent.
#       proxy_set_header X-Forwarded-For $remote_addr;
#       proxy_set_header X-Forwarded-Proto $scheme;
#       proxy_set_header X-Request-Id $request_id;
#       proxy_read_timeout 30s;
#   }
#
#   location /socket.io/ {
#       proxy_pass http://fos_api;
#       proxy_http_version 1.1;
#       proxy_set_header Upgrade $http_upgrade;
#       proxy_set_header Connection $connection_upgrade;
#       proxy_set_header Host $host;
#       proxy_set_header X-Forwarded-For $remote_addr;
#       proxy_set_header X-Forwarded-Proto $scheme;
#       proxy_read_timeout 75s;     # above the Socket.IO ping interval + timeout
#       proxy_send_timeout 75s;
#   }
#
#   location /assets/ {
#       expires 1y;
#       add_header Cache-Control "public, max-age=31536000, immutable" always;
#       include snippets/fos-headers.conf;
#       try_files $uri =404;
#   }
#
#   location / {
#       add_header Cache-Control "no-cache" always;
#       include snippets/fos-headers.conf;
#       try_files $uri /index.html;
#   }
#
# /etc/nginx/snippets/fos-headers.conf (headers common to all apps; nginx drops
# inherited add_header directives when a block adds its own, hence the include)
#
#   add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
#   add_header X-Content-Type-Options "nosniff" always;
#   add_header Referrer-Policy "strict-origin-when-cross-origin" always;
#   add_header Cross-Origin-Opener-Policy "same-origin" always;
#   add_header Content-Security-Policy $fos_csp always;
#   add_header Permissions-Policy $fos_permissions always;

# Media hosts: the CDN/bucket serving public images (PUBLIC_MEDIA_BASE_URL) and,
# for private document previews, the storage endpoint that signs URLs.
# Replace media.example.com / storage.example.com with yours.

server {
    listen 443 ssl;
    http2 on;
    server_name app.example.com;                       # APP_URL_CUSTOMER
    ssl_certificate     /etc/ssl/fos/app.pem;
    ssl_certificate_key /etc/ssl/fos/app.key;
    root /srv/fos/customer-web;

    set $fos_csp "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://media.example.com; font-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";
    set $fos_permissions "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()";
    include snippets/fos-proxy.conf;
}

server {
    listen 443 ssl;
    http2 on;
    server_name partner.example.com;                   # APP_URL_DELIVERY
    ssl_certificate     /etc/ssl/fos/partner.pem;
    ssl_certificate_key /etc/ssl/fos/partner.key;
    root /srv/fos/delivery-web;

    set $fos_csp "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://media.example.com; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";
    # Photo proof uses <input capture>, which needs no camera permission.
    set $fos_permissions "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()";
    include snippets/fos-proxy.conf;
}

server {
    listen 443 ssl;
    http2 on;
    server_name restaurant.example.com;                # APP_URL_RESTAURANT
    ssl_certificate     /etc/ssl/fos/restaurant.pem;
    ssl_certificate_key /etc/ssl/fos/restaurant.key;
    root /srv/fos/restaurant-web;

    set $fos_csp "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://media.example.com https://storage.example.com; font-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";
    set $fos_permissions "geolocation=(), camera=(), microphone=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()";
    include snippets/fos-proxy.conf;
}

server {
    listen 443 ssl;
    http2 on;
    server_name admin.example.com;                     # APP_URL_ADMIN
    ssl_certificate     /etc/ssl/fos/admin.pem;
    ssl_certificate_key /etc/ssl/fos/admin.key;
    root /srv/fos/admin-web;

    # Consider an IP allowlist or VPN in front of the admin console.
    set $fos_csp "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://media.example.com https://storage.example.com; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";
    set $fos_permissions "geolocation=(), camera=(), microphone=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()";
    include snippets/fos-proxy.conf;
}

# Optional: a dedicated API hostname for provider webhooks and API_PUBLIC_URL.
server {
    listen 443 ssl;
    http2 on;
    server_name api.example.com;                       # API_PUBLIC_URL
    ssl_certificate     /etc/ssl/fos/api.pem;
    ssl_certificate_key /etc/ssl/fos/api.key;
    client_max_body_size 11m;

    location = /health/live  { return 404; }           # probe the containers directly, not through the edge
    location = /health/ready { return 404; }

    location / {
        proxy_pass http://fos_api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
    }
}
```

Notes on the headers:

- **CSP**: the production builds load only their own hashed scripts and stylesheets, so `script-src 'self'` and `style-src 'self'` with no `'unsafe-inline'` work; `connect-src 'self'` covers both `/api` and the `wss://` socket on the same host. Add the hosts that serve images (`PUBLIC_MEDIA_BASE_URL`, and for the restaurant and admin apps, which preview private documents, the storage endpoint that signs URLs) to `img-src`. Roll a changed CSP out with `Content-Security-Policy-Report-Only` first.
- **Permissions-Policy** enables `geolocation` only for the customer app (current location, map pin) and the delivery app (going online, live location). Everything else is disabled. The restaurant app's new-order alert uses Web Audio, which needs no permission.
- **HSTS** for a year with subdomains; add `preload` only once every subdomain is HTTPS-only.
- **Framing** is refused by `frame-ancestors 'none'` (and the API sends `X-Frame-Options: DENY`).
- **X-Forwarded-For / trust proxy**: the API trusts exactly one hop. If a CDN or cloud load balancer sits in front of Nginx, either terminate at the load balancer and drop Nginx, or change the hop count in `apps/api/src/platform/http/app.ts` — otherwise rate limits key on the proxy's address (or on a spoofed header).
- Cloud load balancers (ALB, GCLB) work too: route `/api/*` and `/socket.io/*` to the API target group with WebSocket support and an idle timeout ≥ 75 s, everything else to the static origin, and set the headers above on the static responses (CDN response-header policies).

## 5. Health and readiness

| Endpoint | Process | Meaning | Use for |
| --- | --- | --- | --- |
| `GET /health/live` | API (4000) | `{"status":"ok"}` while the process runs | liveness probe (restart on failure) |
| `GET /health/ready` | API | `200` with per-dependency status; `503` when PostgreSQL (critical) is down; Redis core/cache failures are reported as degraded but stay `200` | readiness probe / load-balancer health check |
| `GET /health/live` | Worker (4001) | process up | liveness probe |
| `GET /health/ready` | Worker | `503` unless both PostgreSQL and the core Redis answer (the worker needs both) | readiness probe |

Health endpoints don't use the response envelope and should not be exposed publicly (block them at the edge as above, probe containers directly). There is no `/metrics` endpoint yet (API-SYS-003 is planned).

## 6. Payment webhooks

Register `https://<api host>/api/v1/payments/webhooks/razorpay` in the Razorpay dashboard with a secret listed in `RAZORPAY_WEBHOOK_SECRETS`. The route reads the raw body (256 kB cap) and verifies the signature before parsing; events are stored and processed by the worker, so the worker must be running. Enable automatic capture on the Razorpay account. The payment `sweep`/`resolve-stuck-payments` jobs reconcile missed webhooks by querying the provider.

## 7. Backups and recovery

- **PostgreSQL** is the system of record: enable point-in-time recovery (WAL archiving) with daily snapshots, retention per the data-retention policy, and run a **restore drill** before launch and quarterly (AC-NFR-005). Record the RPO/RTO achieved.
- **Redis core** holds queues, timers and sessions: use persistence (AOF every second) and a replica. Losing it loses in-flight jobs and signs users out; order timers are re-created by the every-5-minute `sweep-order-timers` job and the outbox relay resumes from PostgreSQL.
- **Redis cache** needs no backup.
- **Object storage**: enable versioning (or replication) on the private bucket; KYC documents and invoices can't be regenerated from the database.
- **Secrets**: store `FIELD_ENCRYPTION_KEYS`, `JWT_SIGNING_KEYS` and `AUTH_HMAC_SECRET` in the secret manager with their own backup; a database backup is useless for encrypted fields without the matching field key.

## 8. Observability

- **Logs**: both processes log JSON lines to stdout (pino) with `requestId`, user and route; secrets, tokens, OTPs and phone numbers are redacted. Ship stdout to your log platform; alert on `level >= 50` (error) rates.
- **Request correlation**: the API echoes `x-request-id`; pass Nginx's `$request_id` as `X-Request-Id` to tie edge and API logs together.
- **Ops alerts** inside the product: the admin dashboard shows `ops_alerts` (stuck outbox, dispatch escalations, stale partners, Redis unavailable, failed jobs); the admin "Failed jobs" screen retries dead jobs.
- **What to watch** (also in [tests/load/README.md](../../tests/load/README.md)): API p95 latency and 5xx rate, event-loop lag, PostgreSQL connections and slow queries, Redis memory and latency, BullMQ queue depth and failed counts, outbox lag (`outbox_events.published_at − created_at`), time from order dispatchable to first offer.
- Metrics (`/metrics`), tracing and error tracking (Sentry or similar) are not built in yet; see the future roadmap.

## 9. Scaling notes

- Start: 2 API instances (1 vCPU, 1 GB each), 1 worker, PostgreSQL 2 vCPU / 8 GB, Redis core 1 GB HA, Redis cache 256 MB. Run the k6 peak profile on staging before launch to confirm (the scripts exist but have not been run).
- PostgreSQL connection budget = (API instances + worker instances) × Prisma pool size (`connection_limit` in `DATABASE_URL`); put PgBouncer (transaction mode) in front when it approaches the server limit.
- Location ingestion is Redis-first (GEO sets, throttled fan-out, sampled trail writes); it scales with Redis core, not PostgreSQL.
- Partitioning of `audit_logs`, `delivery_locations` and `notifications` is deferred until the DB-SCALE-001 thresholds.

## 10. Rollout and rollback

1. CI green on the commit (format, lint, typecheck, tests, E2E, docs checks); images built and pushed.
2. Run migrations (`db:deploy`) — backward-compatible only.
3. Roll the **worker** first if the release adds job types or outbox consumers, then the **API** (rolling: one instance at a time, readiness-gated), then publish the **web builds** (upload hashed assets first, then switch `index.html`).
4. Watch error rates, readiness, queue depth and outbox lag for 15 minutes.

Rollback: redeploy the previous image tags and the previous web build (keep the last builds' assets so cached `index.html` files keep working). Do not roll back migrations; a release that needs a schema rollback ships a new forward migration. JWT keys: keep the previous signing key in `JWT_SIGNING_KEYS` for at least the access-token lifetime (15 min) after any key change so a rollback doesn't sign everyone out.

## 11. Security operations

- Rotate `JWT_SIGNING_KEYS` (prepend new, remove old after 15 min), `RAZORPAY_WEBHOOK_SECRETS` (list both during rotation) and `FIELD_ENCRYPTION_KEYS` (append new; old keys stay listed while data uses them) on a schedule; see [ENVIRONMENT.md](ENVIRONMENT.md).
- Database and Redis on private networks only; TLS in transit; least-privilege database roles (a migration role and a runtime role).
- Admin console: restrict by IP/VPN if possible; every admin is created by a super admin and signs in with a password plus an emailed code.
- Run the dependency audit (`pnpm audit --prod`) in CI and before each release.

## 12. Go-live checklist

**Blocking — not built in the MVP**

- [ ] **SMS provider** (OTP sign-in, order SMS) — adapter seam exists (`MessageSink`), no provider; the worker refuses production without one.
- [ ] **Email provider** (admin second factor, password reset, verification, invitations) — same.
- [ ] **Web Push** (VAPID keys, subscription storage) — push currently goes to the worker log only.
- [ ] **Razorpay Checkout in the customer app** — the backend Razorpay adapter exists but has never been run against Razorpay (even in test mode); the customer app only drives the mock checkout. Integrate Checkout.js, add `https://checkout.razorpay.com` (script) and Razorpay's frame/connect hosts to the customer app's CSP and `payment=(self)` to its Permissions-Policy, then test end to end in Razorpay test mode.
- [ ] **S3 storage** exercised against the real bucket (uploads, derivatives, signed links); the driver is untested against a live endpoint.
- [ ] **Geocoding provider** (OD-13) or accept map-pin-only addresses (`GEO_PROVIDER=none`).

**Configuration**

- [ ] All production secrets generated fresh and stored in a secret manager ([ENVIRONMENT.md §7](ENVIRONMENT.md#7-production-checklist-for-configuration)).
- [ ] Razorpay live keys, webhook registered and verified with a test event; automatic capture on.
- [ ] Buckets created: public (read via CDN) and private (no public access, versioning on); CORS not required (uploads go through the API).
- [ ] DNS and TLS for the four app hosts (and the API host if used); `APP_URL_*` and `API_PUBLIC_URL` match exactly.
- [ ] Edge headers per §4 verified (securityheaders.com or `curl -I`); WebSocket upgrade works through every proxy hop.
- [ ] Migrations applied; `db:status` clean; no seed data.

**Reference data to create in the admin console (production starts empty)**

- [ ] Super admin account created with a one-off script against the database (there is no self-registration and no admin invitation flow), then further platform staff: they sign up as ordinary users and a super admin grants them a role on the **Roles** screen, after which they set a password and use the admin console.
- [ ] Delivery zones (polygons), fee schedule and slabs, tax rules (with the accountant), commission plan, partner pay plan, platform settings, cuisines, coupons if any.
- [ ] First restaurants and partners onboarded through the apps and approved.

**Legal and compliance (SRS §20.4 — engineering proposals, not legal advice)**

- [ ] Terms of service, privacy policy, refund and cancellation policy reviewed by counsel and loaded as legal documents (served by `GET /api/v1/legal/{documentType}`; there is no admin editor yet, see KNOWN-LIMITATIONS).
- [ ] GST treatment of food, delivery and platform fees, invoice format and numbering reviewed by a tax advisor (invoice content is an engineering placeholder).
- [ ] Data protection: consent text, retention periods, data-export and deletion processes, grievance officer contact (DPDP Act).
- [ ] FSSAI display requirements for restaurant listings; partner agreements and insurance.
- [ ] Payment aggregator obligations (Razorpay KYC, settlement and refund timelines).

**Operations**

- [ ] Backups with a successful restore drill; alerting on errors, readiness, queue depth and outbox lag.
- [ ] k6 peak profile run on staging with results recorded (AC-NFR-001).
- [ ] On-call runbook: payment webhook failures, Redis outage (dispatch pauses), stuck outbox, refund retries.
- [ ] Owner MVP sign-off.
