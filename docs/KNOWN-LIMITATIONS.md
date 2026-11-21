# Known limitations (MVP release candidate)

What the MVP does **not** do, or does only partly, as of Phase 14 (2026-11-21). Sources: [PROJECT_STATUS.md](../PROJECT_STATUS.md) (verification notes, "planned later", TODO), the SRS API inventory against the [generated OpenAPI document](api/openapi.json) (392 of the 496 inventory rows are implemented; most of the remaining 104 are CORE-tier), and the go-live checklist in the [deployment guide](guides/DEPLOYMENT.md#12-go-live-checklist). Items marked **blocking** must be closed before real customers use the platform. Planned work is grouped in [FUTURE-ROADMAP.md](FUTURE-ROADMAP.md).

## 1. External providers (blocking)

| Limitation | Effect today | What is needed |
| --- | --- | --- |
| **No SMS provider** | OTPs and SMS notifications go to `.local/dev-messages.log` (`DEV_MESSAGE_SINK=file`) or the worker log. The worker refuses to start with `NODE_ENV=production`. | Provider choice, sender ID/DLT registration (India), adapter behind the existing `MessageSink` seam, delivery receipts. |
| **No email provider** | Admin second-factor codes, password resets, verification links and invitations go to the same dev log. Mailpit in Docker Compose receives nothing. | Provider (SES, Postmark…), domain authentication (SPF/DKIM/DMARC), adapter. |
| **No Web Push** | Push notifications are written to the worker log; in-app notifications and socket pushes work. | VAPID keys, subscription storage, service worker in the apps. |
| **Razorpay live mode untested; no Checkout in the customer app** | The backend Razorpay adapter (orders, signature verification, webhooks, refunds, secret rotation) has never been run against Razorpay, not even in test mode. The customer app only drives the development mock checkout; with `PAYMENT_PROVIDER=razorpay` online payment is unavailable in the UI (COD and wallet still work). | Razorpay test keys, Checkout.js integration in the payment step, CSP/Permissions-Policy changes, end-to-end test in test mode, then live keys. |
| **S3 storage driver untested against a live endpoint** | Development uses the local driver; the S3 driver (uploads, WebP derivatives, signed links, deletes) is covered by unit tests only. | Exercise against SeaweedFS or a real bucket before launch. |
| **No geocoding provider** | `GEO_PROVIDER=mock` knows a dozen fictional Bengaluru localities; production defaults to `none`, where address search reports it is unavailable and customers drop a map pin (OD-13). | Provider choice and adapter. |
| **No routing provider** | ETAs and distances use straight-line distance × a road factor and an average speed; no route polylines are drawn on tracking maps. | Routing/maps provider. |

## 2. Product scope not built in the MVP

### Customer

- OAuth sign-in (Google, Apple), TOTP MFA, lost-access account recovery requests, personal data export, avatar upload.
- Restaurant reviews list and rating breakdown on the restaurant page (API-REST-007/008), item ratings and **item thumbs** (FR-REV-003), review prompt 30 minutes after delivery (FR-REV-007).
- Offers pages (restaurants for an offer, branch promotions), popularity, trending and curated collections managed by admins.
- Scheduled orders, group orders, chat with partner or support agent, masked calling.
- Notification preferences beyond the defaults; quiet hours; apology coupons.

### Restaurant

- **Settlement statements and commission invoices** (API-RFIN-001…003, 005): owners see payout history with the settlement breakdown (API-RFIN-006, D-20), not per-period statements or per-order earnings; no masked bank-account read endpoint (API-RFIN-004).
- New outlets after onboarding (API-MER-015), ownership transfer, staff activity log, KDS device pairing.
- Stock counts, item and category schedules, combos, bulk price changes, bulk availability, CSV menu import.
- Restaurant promotions, complaints and statements, peak-hour and branch-comparison analytics, report exports.

### Delivery partner

- **SOS** (API-DP-021), incentive programs (API-EARN-004), editing an existing vehicle (API-DP-011; partners add vehicles instead).
- Batching (two orders per trip), offline queue for stage actions in the PWA, Web Push offers.

### Admin

- **Maker-checker** approvals queue (API-ADM-147…149). Payout batches already enforce approver ≠ maker in the database; other ★ actions are single-person with a mandatory reason and audit.
- **Payment reconciliation** runs and exceptions (API-ADM-088…090); webhook log, provider sync and stuck-payment sweeps exist.
- **Content management**: promotions, banners, collections, FAQs, legal documents, notification templates, support reply macros, broadcasts (API-ADM-106…117, 190…201). Default templates and FAQ/legal content are read from the database but there is no editor.
- Incentive programs, **feature flags** UI (the `feature_flags` table is seeded, but nothing manages it), **ops live map** (API-ADM-004), **custom roles** (API-ADM-181/182; the built-in roles are fixed), admin staff invitations (API-ADM-186; grant roles to existing users instead), audit export, complaints and disputes, analytics series and funnel, report exports, item moderation, notification resend, support address correction, account recovery completion.

### Platform

- No `/metrics` endpoint, tracing or error tracking (API-SYS-003); no public client config endpoint (API-SYS-005); the OpenAPI document is a file, not served by the API (API-SYS-004).
- English only (Hindi planned), India only (INR, IST, +91).
- Monthly partitioning of `audit_logs`, `delivery_locations` and `notifications` is deferred until the DB-SCALE-001 thresholds.

## 3. Verification gaps

- **Load tests not executed.** k6 scripts with NFR thresholds exist ([tests/load](../tests/load/README.md)) but no staging environment exists and k6 was not installed; AC-NFR-001 (peak profile) is unverified.
- **Chaos and multi-instance tests**: Redis outage is covered by an integration test; database failover, multi-instance socket fan-out under load and provider outages have not been exercised on real infrastructure.
- **Docker**: CI builds both images, but Docker Compose and the containers have not been run end to end on a Docker host (development used project-local PostgreSQL and Redis).
- **Coverage**: API 93 % statements / 81 % branches with CI thresholds, but below the testing strategy's domain target in `apps/api/src/platform/realtime/room-policy.ts` and in the `@fos/api-client` and `@fos/validation` packages.
- **Session expiry**: no dedicated test for idle/absolute session expiry (FR-AUTH-023), though the logic is exercised indirectly.
- **Restore drill** (AC-NFR-005) not performed — there is no production-like database yet.
- **Cross-browser**: E2E runs on Chromium only (desktop and a mobile viewport); Firefox and WebKit projects are planned (NFR-COMPAT).
- **Dependency advisories**: production dependencies have 2 low advisories; development-only advisories remain in vitest 3's dependency tree and need the **vitest 4 upgrade**.

## 4. Legal, tax and policy (blocking — SRS §20.4)

The documents in `docs/requirements` are engineering proposals, not legal advice. Before launch:

- Terms, privacy policy, refund and cancellation policy, grievance officer — reviewed by counsel; content loaded into `legal_documents`.
- GST treatment and **invoice content** (currently an engineering placeholder) — reviewed by a tax advisor.
- Data protection (DPDP Act): consent, retention periods, export and deletion processes.
- FSSAI display requirements, partner agreements and insurance, payment-aggregator obligations.

## 5. Operational notes and quirks

- Restaurants follow their seeded hours (most 11:30–23:30 IST); outside them, development ordering fails as "closed" until the hours are changed.
- Online-paid orders stay `PAYMENT_PENDING` until the worker's outbox relay processes the capture; without the worker nothing progresses (timers, dispatch, notifications, refunds).
- The API trusts exactly one proxy hop (`trust proxy` = 1, set in code); other topologies need a code change ([deployment guide §4](guides/DEPLOYMENT.md#4-edge-nginx-reference-configuration)).
- `docker-compose.yml` still describes Mailpit as the "dev SMS/OTP sink"; it is not used by the platform.
- The worker's dev message file and the local storage directory are resolved relative to the repository root, so the processes must run from inside the repository in development.
