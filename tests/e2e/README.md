# End-to-end tests (`@fos/e2e`)

Playwright specs that run the real stack: the API, the worker and the four built apps.

```bash
pnpm --filter @fos/e2e e2e:install   # once: Chromium
pnpm --filter @fos/e2e e2e           # build the apps, start the stack, run everything
```

## What runs

| Spec                      | Covers                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journey.fullstack.spec`  | AC-E2E-001/002/003 as one order in three browsers at once: customer sign-up with the phone code, location, discovery, a customised dish, coupon, checkout, dev payment, live tracking; restaurant accept, preparing, ready, handover with the partner's pickup code, history and dashboard; partner online, live offer, arrivals, delivery code from the customer's tracking page, earnings |
| `failures.fullstack.spec` | AC-E2E-004 payment fails then succeeds (one order, one capture); 005 restaurant rejects (customer told, refund created); 006 first partner declines, the next one accepts; 007 cancel after the free window (fee preview, partial refund); 008 no partner: escalation on the admin dispatch board, cancellation and full refund at the deadline                                             |
| `session.fullstack.spec`  | AC-E2E-009 a replayed refresh token revokes the session; both open tabs are signed out                                                                                                                                                                                                                                                                                                      |
| `auth.fullstack.spec`     | OTP sign-up for a new number, session persistence and sign-out; wrong code                                                                                                                                                                                                                                                                                                                  |
| `a11y.spec`               | AC-NFR-002: no serious/critical axe violations on the key pages of each app (desktop and phone)                                                                                                                                                                                                                                                                                             |
| `shell.spec`              | Customer shell: first visit, 404, skip link, restaurants that can't load (desktop and phone)                                                                                                                                                                                                                                                                                                |

The journeys share partners and restaurants, so tests run one at a time.

## The stack

`support/global-setup.ts` does everything, and its returned teardown stops it:

1. Creates the database `fos_e2e` if missing (same server and credentials as `DATABASE_URL` in the repo's `.env`, else `E2E_DATABASE_URL`), migrates it and loads the development seed. It refuses any database whose name doesn't end in `_e2e`.
2. E2E-only data setup in that database: every branch gets one 23 h 59 min slot a day starting an hour before now (seeded hours would close restaurants at night); the free cancellation window is 15 s instead of 60 s; restaurant staff and two admins get a password generated for the run (`.local/e2e/run.json`).
3. Flushes Redis database indexes 13 (core) and 14 (cache) on the `.env` servers (`E2E_REDIS_CORE_URL`, `E2E_REDIS_CACHE_URL`).
4. Builds the four apps (skip with `E2E_SKIP_BUILD=1`), then starts the API on 4300, the worker (health on 4301) and `vite preview` for customer/restaurant/delivery/admin on 5373–5376, proxied to the API. Ports can be changed with `E2E_*_PORT`. Logs go to `.local/e2e/logs`.

One-time codes and the admin's emailed second factor are read from the worker's message sink, `.local/e2e/dev-messages.log` (`DEV_MESSAGE_FILE`).

Each browser context sends its own `X-Forwarded-For`, so the per-IP sign-in limits apply per "device" as they would in real use. Partners get Playwright geolocation; `moveTo` waits out the app's 10 s position cache.

## Time

Nothing in the apps is shortened for tests. Two things are arranged in data instead:

- The free cancellation window (AC-E2E-007) is 15 s in the E2E database.
- AC-E2E-008's no-partner deadline (30–45 min) is moved to now in the database (`support/db-tool.ts`); the worker's own once-a-minute dispatch retry and sweep then cancel the order. This is the only test-side database write.

## Iterating

`E2E_REUSE_STACK=1` skips global setup and runs against a stack that is already up (for example one started by running the global setup in a separate script). State from earlier runs stays, so partners may still be online and a phone number's 30 s resend cooldown may apply.
