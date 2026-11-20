# SRS Section 17 — Interface Requirements

> Part of FOS-SRS-001 v0.4.1 (APPROVED 2026-11-20).

## 17.1 User interfaces

### 17.1.0 Shared design system (`packages/ui`)

| ID | Requirement |
|---|---|
| UI-DS-001 | One design system shared by all four apps: Tailwind CSS tokens (color, spacing 4-px scale, radius, shadow, typography) + shadcn/ui primitives (Radix-based, accessible) wrapped as `@fos/ui` components. |
| UI-DS-002 | Typography: Inter (UI) with tabular numerals for prices and timers; scale 12/14/16/18/20/24/30/36 px. |
| UI-DS-003 | Color: brand primary (warm orange, AA-contrast variant for text), semantic success/warning/danger/info, neutral grays; dark mode for admin/restaurant (CORE). Dietary marker colors reserved and never reused for other meaning: VEG green `#0F8A3B`, NON_VEG red `#C62828`, EGG amber `#E0A100`. |
| UI-DS-004 | Required components: Button, IconButton, Input, Textarea, Select, Combobox, Checkbox, Radio, Switch, Slider, DatePicker, TimeRangePicker, Table (sortable, paginated), Card, Badge, Tag, Avatar, Tabs, Accordion, Dialog, AlertDialog (confirmation), Drawer/Sheet, Popover, DropdownMenu, Tooltip, Toast, Skeleton, EmptyState, ErrorState, Stepper, Countdown, Map (Leaflet wrapper), PriceBreakdown, DietaryMarker, RatingStars, StatusPill, OrderTimeline, FileUploader, OTPInput, QuantityStepper, CustomizationSheet. |
| UI-DS-005 | **DietaryMarker:** square outline with filled circle (VEG, green), square outline with filled upward triangle (NON_VEG, red), square outline with filled circle (EGG, amber) — shape + color + `aria-label` ("Vegetarian"/"Non-vegetarian"/"Contains egg"); sizes 12/16/20 px; appears left of every item name everywhere. |
| UI-DS-006 | Status vocabulary is shared (same pill labels/colors for the same states across apps). |
| UI-DS-007 | Every component documented in Storybook (CORE) with accessibility checks. |

### 17.1.1 Customer interface (responsive web, mobile-first)

| Page | Key elements | Primary interactions |
|---|---|---|
| Landing (signed-out) | Location prompt, value proposition, popular cuisines | Detect location / enter address → Home |
| Login / Register / OTP | Phone-first form, email+password alternative, OTP input with resend timer | Authenticate |
| Location selection | Map with draggable pin, autocomplete, saved addresses | Set delivery location |
| Home | Location header, search bar, veg-only toggle, banners carousel, cuisine chips, collections rows, restaurant list (infinite scroll) | Browse, filter, open restaurant |
| Discovery / listing | Filters drawer, sort menu, result count, restaurant cards (ETA, fee, rating, offer, closed state) | Filter/sort |
| Search | Suggestions, history, trending, tabbed results (Restaurants / Dishes) | Search, add dish |
| Restaurant details & menu | Header (status, ETA, fee, rating, FSSAI), offers strip, sticky category nav, menu search, veg filter, item cards, view-cart bar | Add item, customize |
| Item customization sheet | Variants (radio), groups with min/max hints, live price, instructions, quantity | Add to cart |
| Cart | Lines with edit/remove, unavailable flags, coupons entry, price breakdown, min-order progress | Proceed to checkout |
| Checkout | Address selector, ETA, delivery instructions, contactless toggle, tip chips, payment method selector, wallet toggle, final breakdown, sticky Pay button | Place order |
| Payment | Provider hosted checkout, confirming state, failure + retry | Pay |
| Order confirmation | Order number, ETA, summary, Track button | Go to tracking |
| Live tracking | Map, stage timeline, partner card, delivery code, ETA, help button, cancel (if allowed) | Track, cancel, get help |
| Order history / details | List with status filters, details with breakdown, invoice download, reorder, review, report issue | Reorder, review |
| Favorites | Restaurants & dishes tabs | Open/remove |
| Profile / settings | Profile, preferences (veg, allergens), sessions & devices, notification settings, delete account | Manage |
| Addresses | List, add/edit (map), default | Manage |
| Notifications | Inbox with unread state | Open deep link |
| Reviews | My reviews, write/edit review | Rate |
| Support | FAQs, my tickets, ticket conversation | Get help |
| Wallet | Balance, history, expiring credits | View |

### 17.1.2 Restaurant interface (desktop/tablet)

Pages: Login · Onboarding wizard (business → branch → documents → bank → review & submit) · Verification status · Dashboard · Orders (queue tabs with live alerts) · Order details · Kitchen display (full-screen) · Menu (categories, items, item editor, customization groups, availability board) · Inventory/stock (CORE) · Offers & promotions · Analytics · Reviews · Branches · Staff & invitations · Restaurant settings · Operating hours & holidays · Payments/settlements · Payouts · Notifications.

Requirements: persistent branch switcher (for multi-branch members); global "Accepting orders" status chip with one-click pause; new-order modal that can't be missed (sound + modal + browser notification); offline banner + automatic polling fallback.

### 17.1.3 Kitchen display (KDS)

Full-screen landscape layout; columns New/Accepted · Preparing · Ready; ticket = order number, age timer, items with modifiers in large type, cooking instructions highlighted; bump buttons; no prices or customer data; audible cue on new/cancelled tickets; auto-reconnect; theme high-contrast.

### 17.1.4 Delivery partner interface (mobile PWA)

Pages: Login · Registration · Application & document submission · Verification status · Dashboard (online toggle, today's earnings, current state) · Offer card (full-screen, countdown, accept/reject) · Active delivery (stage screens: to restaurant → at restaurant → to customer → at customer/handover) · Navigation hand-off (deep links) · Delivery history · Earnings (day/week/month) · Incentives · Ratings & performance · Cash-in-hand · Payouts · Notifications · Profile · Vehicles & documents · Settings (permissions check, battery tips) · Support.

Requirements: large controls, slide-to-confirm for stage transitions, persistent "GPS/Network" health indicator, wake lock during active delivery, works under poor network (queued actions with idempotency keys and visible pending state).

### 17.1.5 Admin interface (desktop)

Pages per FR-ADMIN list: Login (+MFA) · Dashboard · Ops alerts · Customers · Restaurants · Restaurant approvals · Restaurant details · Delivery partners · Partner approvals · Orders · Order details (360 view) · Dispatch board · Payments · Refunds · Reconciliation · Payouts · Promotions · Coupons · Banners & collections · Zones (map editor) · Support desk · Complaints & disputes · Review moderation · Analytics · Reports · Platform configuration (settings, fees, taxes, commission, pay plans, flags) · Roles & permissions · Admin users · Audit logs · Content (FAQs, legal docs, cuisines, templates) · Jobs (dead-letter).

## 17.2 API interface standards

Defined in §14.1. Additionally:
- Internal module interfaces are TypeScript service interfaces; cross-module calls are synchronous in-process calls or domain events — never HTTP between modules (until extraction).
- Shared request/response types are generated from Zod schemas (`@fos/validation`) and consumed by `@fos/api-client`.

## 17.3 Payment interfaces

| ID | Requirement |
|---|---|
| IF-PAY-001 | `PaymentProvider` adapter contract (FR-PAY-001). Implementations: `RazorpayProvider` (MVP), `MockProvider` (dev/test: deterministic scenarios via test card/VPA patterns), `StripeProvider` (ADV). |
| IF-PAY-002 | Razorpay: Orders API (create with amount in paise, currency INR, receipt, notes), Standard Checkout on client, payment signature verification (HMAC-SHA256 `order_id + "|" + payment_id` with key secret), Payments API fetch, Refunds API (with `notes.refund_id` for idempotency mapping), webhooks (`payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`, `refund.processed`, `refund.failed`) verified with webhook secret (HMAC-SHA256 of raw body), settlements API for reconciliation. |
| IF-PAY-003 | Provider credentials per environment (test keys in non-production); the client receives only the public key ID. |
| IF-PAY-004 | Timeouts 10 s; retries only for idempotent reads; creation retries guarded by receipt/notes lookup before re-create. |
| IF-PAY-005 | Payout provider adapter (CORE): `PayoutProvider` (`createPayout`, `getPayout`, webhook) for RazorpayX-like APIs; manual bank-file export as baseline. |

## 17.4 Maps and location interfaces

| ID | Requirement |
|---|---|
| IF-GEO-001 | `GeocodingProvider`: `autocomplete(query, bias, sessionToken)`, `placeDetails(placeId)`, `reverse(lat, lng)`, `geocode(address)`. Implementations: `MockGeocoder` (dev, seeded addresses for the pilot city), production provider TBD (OD-13). |
| IF-GEO-002 | `RoutingProvider`: `route(origin, destination, mode)` → distance, duration, polyline; `matrix(origins, destinations)` for dispatch ranking (CORE). Fallback: haversine × road factor, speed by vehicle type (bicycle 12 km/h, motorbike 22 km/h city average ⚙). |
| IF-GEO-003 | Map display: Leaflet with OpenStreetMap tiles (attribution displayed; tile usage policy respected — production uses a commercial tile provider or self-hosted tiles to avoid OSM tile server limits). |
| IF-GEO-004 | Navigation for partners: deep links to Google Maps / Apple Maps with destination coordinates (no in-app turn-by-turn). |
| IF-GEO-005 | Browser Geolocation API: `watchPosition` with `enableHighAccuracy: true` during active deliveries, `maximumAge` 5 s, `timeout` 15 s. |
| IF-GEO-006 | Provider calls are cached (geocodes 30 d, routes 5 min per origin/destination cell) and rate-limited to control cost. |

## 17.5 Notification interfaces

| ID | Requirement |
|---|---|
| IF-NTF-001 | `EmailProvider` (SMTP/API): send(to, subject, html, text, headers). Dev: Mailpit container. Production: SES/SendGrid/Postmark (TBD). SPF/DKIM/DMARC configured. |
| IF-NTF-002 | `SmsProvider`: send(to, templateId, variables) using DLT-registered templates (India), with sender ID; delivery receipts via webhook (CORE). Dev: log sink viewable in Mailpit-like UI. |
| IF-NTF-003 | `PushProvider`: Web Push (VAPID) for all web apps; FCM adapter for future native apps. |
| IF-NTF-004 | All providers behind the notifications module; provider failure → retry → fallback channel per template policy. |

## 17.6 Storage interfaces

| ID | Requirement |
|---|---|
| IF-STO-001 | `StorageProvider`: `putObject`, `getSignedReadUrl(key, ttl)`, `getSignedUploadUrl` (CORE, direct-to-bucket uploads), `deleteObject`, `headObject`. Implementations: LocalDisk (unit/dev without docker), S3-compatible (SeaweedFS in docker, S3/R2 in production). |
| IF-STO-002 | Buckets: `public-media` (food/logos/covers/avatars derivatives, served via CDN), `private-docs` (KYC, proofs, invoices, exports; signed URLs only). |
| IF-STO-003 | Object keys are random (`{purpose}/{yyyy}/{mm}/{uuid}.{ext}`); never derived from user-supplied filenames. |

## 17.7 Hardware / device interfaces

- Restaurant: optional 80 mm thermal printer through browser print dialog; speakers for alerts.
- Partner: smartphone GPS, camera (photo proof), vibration, screen wake lock.
- No other hardware integrations in scope.
