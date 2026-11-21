# Environment variables

Every variable the platform reads, derived from the Zod schemas that validate them at boot:

- API: [`apps/api/src/config/env.ts`](../../apps/api/src/config/env.ts), plus the shared storage fields ([`modules/files/config.ts`](../../apps/api/src/modules/files/config.ts)) and payment fields ([`modules/payments/config.ts`](../../apps/api/src/modules/payments/config.ts)).
- Worker: [`apps/worker/src/env.ts`](../../apps/worker/src/env.ts) (reuses the same storage and payment fields).

Both processes **refuse to start** when a value is missing or malformed; the error names the variable, never its value. In development `pnpm dev` loads the repository's `.env` (`tsx --env-file-if-exists=../../.env`); copy [`.env.example`](../../.env.example), which lists every variable below with safe development placeholders. In production, inject variables from your platform's secret manager — never ship a `.env` file in an image.

Legend: **Req** = required in every environment · **Prod** = required (or constrained) only when `NODE_ENV=production` · **Opt** = optional.

## 1. Shared by the API and the worker

| Variable | Req | Default | Purpose and production notes |
| --- | --- | --- | --- |
| `NODE_ENV` | Opt | `development` | `development`, `test` or `production`. Production turns on every check in this document. The Docker images set `production`. |
| `LOG_LEVEL` | Opt | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs are JSON (pino) with secrets, tokens and phone numbers redacted. Use `info` in production. |
| `DATABASE_URL` | Req | — | `postgres://` or `postgresql://` URL of PostgreSQL 16+ with PostGIS. Prisma also reads it for migrations (`db:deploy`). Use a TLS connection (`?sslmode=require`) to a managed database and size `connection_limit` for the number of API and worker instances. |
| `REDIS_CORE_URL` | Req | — | `redis://` or `rediss://` URL of the **core** Redis: BullMQ queues, locks, rate limits, sessions, the Socket.IO adapter and live partner state. Must run with `maxmemory-policy noeviction` and persistence (AOF); highly available in production. |
| `AUTH_HMAC_SECRET` | Req | — | ≥ 32 bytes. HMAC key for OTP codes and identifier hashes; the worker uses it for account anonymisation tombstones. **Same value in the API and the worker.** Rotating it invalidates outstanding OTPs and changes identifier hashes, so treat it as long-lived. Generate with `openssl rand -base64 48`. |
| `PAYMENT_PROVIDER` | Opt | `mock` outside production, `razorpay` in production | `mock` is an in-memory provider that signs callbacks and webhooks like Razorpay; production refuses it. |
| `RAZORPAY_KEY_ID` | Prod | — | Razorpay API key id. Required in production (with the two below). Use test-mode keys on staging. |
| `RAZORPAY_KEY_SECRET` | Prod | — | Razorpay API key secret (secret). |
| `RAZORPAY_WEBHOOK_SECRETS` | Prod | — | Comma-separated webhook secrets. To rotate, list the new secret next to the old one, change it in the Razorpay dashboard, then remove the old one (FR-PAY-014). |
| `MOCK_PAYMENT_KEY_SECRET` | Opt | `mock-key-secret-dev-only` | ≥ 8 characters. Signing secret of the mock provider. Only used when `PAYMENT_PROVIDER=mock`. |
| `MOCK_PAYMENT_WEBHOOK_SECRET` | Opt | `mock-webhook-secret-dev-only` | ≥ 8 characters. Webhook secret of the mock provider. |
| `STORAGE_DRIVER` | Opt | `local` outside production, `s3` in production | `local` keeps files under `STORAGE_LOCAL_DIR` and serves them from the API; `s3` uses an S3-compatible service (AWS S3, Cloudflare R2, SeaweedFS in development). Production requires `s3`. |
| `STORAGE_LOCAL_DIR` | Opt | `.local/storage` | Directory of the local driver. A relative path is resolved from the repository root (two levels above the process's working directory, `apps/api` or `apps/worker`). |
| `STORAGE_ENDPOINT` | Opt | — | S3 endpoint URL. Leave unset for AWS S3; set for R2, SeaweedFS (`http://localhost:8333` in Docker Compose) or MinIO. |
| `STORAGE_REGION` | Opt | `us-east-1` | S3 region (`auto` for R2). |
| `STORAGE_ACCESS_KEY` | Prod | — | S3 access key id. Required in production. |
| `STORAGE_SECRET_KEY` | Prod | — | S3 secret access key (secret). Required in production. |
| `STORAGE_PUBLIC_BUCKET` | Opt | `fos-public-media` | Bucket for public images (WebP derivatives of logos, dish photos). |
| `STORAGE_PRIVATE_BUCKET` | Opt | `fos-private-docs` | Bucket for private documents (KYC, originals); only reachable through short-lived signed links. Block all public access on it. |
| `PUBLIC_MEDIA_BASE_URL` | Opt | local driver: the API's `/api/v1/media` route; s3 driver: the public bucket's URL (`<STORAGE_ENDPOINT>/<bucket>` or `https://<bucket>.s3.<region>.amazonaws.com`) | CDN or bucket URL from which browsers load public media. Set it in production to serve images from a CDN. Whatever host serves media must be allowed in the web apps' `img-src` CSP, and the public bucket (or CDN origin) must allow anonymous reads. |
| `API_PUBLIC_URL` | Prod | `http://localhost:<API_PORT>` | How browsers reach the API (signed file links, local media). Required and `https://` in production. |

## 2. API only

| Variable | Req | Default | Purpose and production notes |
| --- | --- | --- | --- |
| `API_PORT` | Opt | `4000` | HTTP and Socket.IO port. |
| `REDIS_CACHE_URL` | Req | — | Disposable read cache (menus, permissions, discovery). `allkeys-lru`, no persistence needed; may be a separate, smaller instance. |
| `APP_URL_CUSTOMER` | Opt | `http://localhost:5173` | Public URL of the customer app. |
| `APP_URL_RESTAURANT` | Opt | `http://localhost:5174` | Public URL of the restaurant app. |
| `APP_URL_DELIVERY` | Opt | `http://localhost:5175` | Public URL of the delivery partner app. |
| `APP_URL_ADMIN` | Opt | `http://localhost:5176` | Public URL of the admin console. |
| `JWT_SIGNING_KEYS` | Req | — | Comma-separated `kid:secret` pairs, each secret ≥ 32 bytes, unique key ids. The **first** key signs access tokens; all listed keys verify them. Rotate by prepending a new key, deploying, and removing the old key after the access-token lifetime has passed (ADR-003). Secret. |
| `JWT_ISSUER` | Opt | `fos-api` | `iss` claim of access tokens. Same value on every API instance. |
| `COOKIE_SECURE` | Opt | `true` in production, else `false` | `true`/`false`. Secure flag of the refresh cookie. Must be `true` in production; `false` only for plain-http localhost. |
| `DEV_MESSAGE_SINK` | Opt | `file` | `file` or `log`. Where development OTPs and emails would go (the worker does the delivery). |
| `GEO_PROVIDER` | Opt | `mock` outside production, `none` in production | `mock` = fictional Bengaluru gazetteer; `none` = no geocoder (address search reports `GEO_PROVIDER_UNAVAILABLE`, customers drop a map pin). Production refuses `mock` (OD-13). |
| `FIELD_ENCRYPTION_KEYS` | Prod | Derived from `AUTH_HMAC_SECRET` outside production | `<id>:<base64 of 32 bytes>` entries, comma-separated, ids 1–255, **newest last**. AES-256-GCM keys for PAN and bank account numbers. Each ciphertext records its key id, so to rotate append a new key (`…,2:<new>`); new writes use it and old values stay readable while the old key is listed. Never remove a key while data encrypted with it remains. Generate with `openssl rand -base64 32`. Required in production. |

### How the `APP_URL_*` values are used

The API derives each app's **origin** (`scheme://host:port`) from these URLs and uses them for:

- the **CORS allowlist** (`Access-Control-Allow-Origin`), with credentials allowed only on `/api/v1/auth/*` (the refresh cookie);
- the **per-app Origin check** on cookie endpoints: a request with `X-Client-App: RESTAURANT` must come from the restaurant app's origin;
- the Socket.IO CORS allowlist;
- links in emails (password reset, email verification, invitations).

In production all four must be `https://`. When the apps are served from the same origin as the API (recommended, see the [deployment guide](DEPLOYMENT.md)), cross-origin requests do not occur, but the Origin check still applies, so the values must match the hostnames users actually load.

### Trust proxy

The API sets Express `trust proxy` to **1** (one hop) in code: it takes the client IP from the last `X-Forwarded-For` entry added by the reverse proxy. Rate limits and audit IPs depend on it. Exactly one proxy hop (Nginx or a load balancer) must sit in front of the API and must overwrite `X-Forwarded-For` (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` on an edge that strips client-supplied values, or `$remote_addr`). With two hops (CDN → load balancer → Nginx) the hop count in `apps/api/src/platform/http/app.ts` must change; this is code, not configuration.

## 3. Worker only

| Variable | Req | Default | Purpose and production notes |
| --- | --- | --- | --- |
| `WORKER_HEALTH_PORT` | Opt | `4001` | Port of the worker's `/health/live` and `/health/ready`. |
| `DEV_MESSAGE_SINK` | Opt | `file` | `file` writes OTPs, emailed codes and links to `DEV_MESSAGE_FILE`; `log` writes them to the worker log. **Production has no message sink**: the worker refuses to start with `NODE_ENV=production` until real SMS and email providers are integrated (see [KNOWN-LIMITATIONS.md](../KNOWN-LIMITATIONS.md)). |
| `DEV_MESSAGE_FILE` | Opt | `.local/dev-messages.log` | Resolved relative to the repository root (two levels above the worker's working directory, `apps/worker`). |

The worker does not read `REDIS_CACHE_URL`, `JWT_*`, `APP_URL_*` or `GEO_PROVIDER`.

## 4. Web apps

The four Vite apps have **no runtime or build-time variables**: they call the API on their own origin (`/api/v1`, `/socket.io`), so production hosting must proxy those paths (see the deployment guide). One variable is read by the Vite dev and preview servers only:

| Variable | Req | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_API_PROXY_TARGET` | Opt | `http://localhost:4000` | Where `vite dev` / `vite preview` proxy `/api`, `/health` and `/socket.io` (WebSocket). Read from the shell, not from `.env`. |

Ports are fixed in each `vite.config.ts` (`strictPort`): customer 5173, restaurant 5174, delivery 5175, admin 5176.

## 5. Tooling and tests

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `TEST_DATABASE_URL` | `@fos/db` and `@fos/api` integration tests | — (tests skipped with a warning) | A dedicated `*_test` database; it is wiped. The API suite uses `<name>_api` next to it. Read from the environment or `.env`. |
| `TEST_REDIS_URL` | `@fos/api` integration tests | — (skipped) | A dedicated Redis database index (e.g. `/15`); it is flushed. |
| `SHADOW_DATABASE_URL` | `pnpm --filter @fos/db db:drift` | — | Scratch database Prisma replays migrations into. |
| `E2E_DATABASE_URL` | Playwright (`tests/e2e`) | `.env` `DATABASE_URL` with the database `fos_e2e` | Must end in `_e2e` (it is truncated and re-seeded). |
| `E2E_REDIS_CORE_URL` / `E2E_REDIS_CACHE_URL` | Playwright | `.env` Redis URLs with indexes 13 / 14 | Flushed at the start of a run. |
| `E2E_API_PORT`, `E2E_WORKER_PORT` | Playwright | `4300`, `4301` | Ports of the isolated E2E stack. |
| `E2E_CUSTOMER_PORT`, `E2E_RESTAURANT_PORT`, `E2E_DELIVERY_PORT`, `E2E_ADMIN_PORT` | Playwright | `5373`–`5376` | `vite preview` ports of the four apps. |
| `E2E_SKIP_BUILD` | Playwright | unset | `1` reuses existing app builds. |
| `E2E_REUSE_STACK` | Playwright | unset | `1` skips global setup and runs against a stack that is already up. |
| `E2E_LOG_LEVEL` | Playwright | `info` | `LOG_LEVEL` of the E2E API and worker. |
| `CI` | Playwright | unset | Retries once, forbids `.only`, GitHub reporter. |
| `BASE_URL` | k6 scripts, `tests/load/smoke.mjs` | `http://localhost:4000` | API base URL of the stack under test (staging). |
| `ORIGIN_CUSTOMER`, `ORIGIN_RESTAURANT`, `ORIGIN_DELIVERY` | k6 | `http://localhost:5173`–`5175` | `Origin` header sent per app; must match the target's `APP_URL_*`. |
| `CUSTOMERS_FILE`, `PARTNERS_FILE` | k6 | — | JSON account lists (`[{ "phone", "password" }]`); keep them out of git. |
| `CUSTOMER_PHONE` / `CUSTOMER_PASSWORD`, `PARTNER_PHONE` / `PARTNER_PASSWORD` | k6 | seeded phones, empty password | Single account when no file is given. |
| `STAFF_PHONE`, `STAFF_PASSWORD`, `BRANCH_ID` | k6 `sockets.js` | manager `+919000000301` | Restaurant manager who accepts the probe orders, and their branch. |
| `DURATION`, `PEAK_VUS`, `HOLD`, `RATE`, `ORDERS_PER_MIN`, `PARTNER_VUS`, `PERIOD`, `IDLE_SOCKETS`, `PROBES_PER_MIN` | k6 | see [tests/load/README.md](../../tests/load/README.md) | Load profile overrides. |

The E2E suite sets `E2E_STAFF_PASSWORD` and `DEV_MESSAGE_FILE` for its own processes; do not set them yourself.

`docker-compose.yml` overrides `DATABASE_URL` and the Redis URLs for the `api` and `worker` containers so they reach the Compose services by name.

## 6. Not used

`SMTP_HOST` and `SMTP_PORT` appeared in earlier versions of `.env.example` but are read by nothing: there is no email provider yet, and the Mailpit container in Docker Compose receives no mail from the platform (development email goes to `.local/dev-messages.log`). They have been removed from `.env.example`.

## 7. Production checklist for configuration

- [ ] `NODE_ENV=production` on the API, the worker and the migration job.
- [ ] Fresh, random `JWT_SIGNING_KEYS`, `AUTH_HMAC_SECRET` and `FIELD_ENCRYPTION_KEYS`, stored in a secret manager, never reused from development, never logged. Back up `FIELD_ENCRYPTION_KEYS` separately from database backups: losing a key makes the PAN and bank fields encrypted with it unreadable.
- [ ] `APP_URL_*` and `API_PUBLIC_URL` are the real `https://` URLs; `COOKIE_SECURE` left at its default (`true`).
- [ ] `PAYMENT_PROVIDER=razorpay` (the default) with live keys; webhook URL `https://<api host>/api/v1/payments/webhooks/razorpay` registered with the matching secret; automatic capture enabled on the Razorpay account.
- [ ] `STORAGE_DRIVER=s3` (the default) with credentials scoped to the two buckets; private bucket blocks public access.
- [ ] `GEO_PROVIDER` left at `none` until a geocoding provider is integrated.
- [ ] Redis core with `noeviction` and persistence; separate cache instance or database.
