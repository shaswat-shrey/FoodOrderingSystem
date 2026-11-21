# Future roadmap (after the MVP)

Builds on [ROADMAP.md](ROADMAP.md) (phases 15+ "CORE release" and "later: ADV / FUT") and the gaps in [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md). Tiers follow the SRS: **MVP** = launch scope, **CORE** = the first release after launch, **ADV** = advanced, **FUT** = future. Endpoint IDs refer to the [API inventory](requirements/API-SPECIFICATION.md). Order within a group is the suggested order.

## 0. Launch blockers (finish the MVP release)

Not new scope: these make the built MVP launchable.

1. **Owner MVP sign-off** on the release candidate.
2. **SMS and email providers** behind the existing `MessageSink` seam (OTP, admin second factor, resets, invitations, order notifications); remove the worker's production guard.
3. **Razorpay end to end**: test-mode run of the backend adapter, Checkout.js in the customer payment step, then live keys and webhook registration.
4. **Staging environment**: Dockerfiles and Compose on a real host, S3 bucket exercised, k6 peak profile run (AC-NFR-001), restore drill (AC-NFR-005).
5. **Legal and tax review** (SRS §20.4): legal documents, invoice content, GST, data-protection processes.
6. Small hardening items: idle/absolute session-expiry test (FR-AUTH-023), coverage in `realtime/room-policy.ts`, `@fos/api-client` and `@fos/validation`, vitest 4 upgrade for the dev-only advisories.

## 1. CORE release

### Growth and engagement

- **Promotions engine**: restaurant promotions (API-RPROMO-001…005) and platform promotions with approval (API-ADM-106…109); branch offers (API-REST-006), restaurants for an offer (API-DISC-007).
- **Merchandising**: banners and curated collections (API-ADM-110…117); popularity and trending; search suggestions.
- **Web Push** and notification preferences; quiet hours; review prompt 30 min after delivery (FR-REV-007); apology coupons; broadcasts to segments (API-ADM-199).
- **Reviews**: public review list and rating summary on the restaurant page (API-REST-007/008), item thumbs and item ratings (FR-REV-003, API-MENU-008), review moderation of items (API-ADM-039).

### Accounts and trust

- OAuth sign-in (API-AUTH-017/018), admin **TOTP MFA** (API-AUTH-019/020), account recovery requests and completion (API-AUTH-024, API-ADM-018), personal data export (API-USER-012), avatar (API-USER-004/005).
- **Maker-checker** queue for high-risk admin actions (API-ADM-147…149), audit export (API-ADM-188).
- **Custom admin roles** (API-ADM-181/182) and admin staff invitations (API-ADM-186).
- Complaints and disputes across support, restaurants and admin (API-RORD-013/014, API-ADM-158…162).

### Restaurants

- **Settlement statements**, per-order earnings and commission invoices (API-RFIN-001…005).
- New outlets after onboarding (API-MER-015), ownership transfer, staff activity log, KDS device pairing (API-RSTAFF-009…011).
- Menu power tools: stock counts, item and category schedules, combos, bulk availability and bulk price changes (API-RMENU-027…034).
- Analytics: peak hours, branch comparison, report exports (API-RANL-005, 006, 008, 009).

### Delivery partners

- **SOS** with ops escalation (API-DP-021).
- **Incentive programs** for partners (API-EARN-004, API-ADM-141…143).
- Vehicle editing (API-DP-011); PWA offline queue for stage actions and location points; Web Push offers.

### Operations and finance

- **Reconciliation** runs and exception handling against provider settlements (API-ADM-088…090).
- **Automated payouts** through a payouts provider (today: batches approved in the console, exported as CSV and marked paid with UTR).
- **Feature flags** UI with per-app targeting (API-ADM-144…146) and the public client config endpoint (API-SYS-005).
- **Ops live map** of partners and orders per zone (API-ADM-004); notification resend and support address correction (API-ADM-066, 068).
- **Content management**: FAQs, legal document versions, notification templates, support macros (API-ADM-156/157, 190…201).
- Analytics series, funnel and exports (API-ADM-170…176).

### Platform

- **Observability**: `/metrics` (API-SYS-003), OpenTelemetry traces, error tracking, dashboards and alert rules (NFR-OBS).
- Serve the generated OpenAPI document from the API with a viewer in non-production environments (API-SYS-004).
- **Geocoding and routing providers**: address search in production, road distances and route polylines on tracking maps.
- Cross-browser E2E (Firefox, WebKit), scheduled chaos tests on staging, OWASP ZAP scan in CI.
- Surge pricing automation (manual zone surge exists).

## 2. ADV — advanced

- **Order batching** (two pickups or drops per trip) and smarter dispatch (learned acceptance, rebalancing idle partners).
- **ML ETA** from historical trips; prep-time prediction per restaurant.
- **Fraud scoring** (promo abuse, COD no-shows, GPS spoofing beyond the current checks).
- **In-app chat** between customer, partner and support; **masked calling**.
- Per-branch pricing; CSV menu import (API-RMENU-035).
- **Hindi** and other Indian languages.
- Read replicas and table partitioning once DB-SCALE-001 thresholds are reached.

## 3. FUT — future

- Native mobile apps (customer and partner).
- Scheduled and group orders.
- Restaurant POS integrations.
- Multi-city and multi-currency operation beyond the pilot.
