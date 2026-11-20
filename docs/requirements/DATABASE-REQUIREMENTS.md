# SRS Section 15 — Database Requirements

> Part of FOS-SRS-001 v0.2.0 (APPROVED 2026-11-20). ERD diagrams: [`docs/database/ERD.md`](../database/ERD.md). Decisions: ADR-004 (PostgreSQL only), ADR-005 (PostGIS with Prisma), ADR-007 (money), ADR-011 (ledger).

## 15.1 Technology

| Item | Requirement |
|---|---|
| DB-TECH-001 | PostgreSQL 16 is the single system of record for all transactional data listed in master prompt §2. |
| DB-TECH-002 | Extensions: `postgis` (geography, GiST), `pg_trgm` (similarity search), `unaccent`, `citext` (case-insensitive email/codes), `pgcrypto` (`gen_random_uuid` fallback; app generates UUIDv7). |
| DB-TECH-003 | Prisma is the schema & migration tool; SQL features Prisma cannot express (PostGIS columns/indexes, partial unique indexes, check constraints, triggers, generated `tsvector` columns, partitioning, grants) are added in migration SQL and documented in `docs/database/`. |
| DB-TECH-004 | Connection pooling: Prisma pool per process (default `connection_limit` = 2 × vCPU + 1) behind PgBouncer (transaction mode) in production; long-running reporting queries go to a read replica (CORE). |
| DB-TECH-005 | Large binaries (images, documents, PDFs) are never stored in PostgreSQL; only `files` metadata rows referencing object storage keys. |

## 15.2 Global conventions

| ID | Rule |
|---|---|
| DB-CONV-001 | Table names `snake_case` plural; Prisma models PascalCase singular mapped with `@@map`. |
| DB-CONV-002 | Primary keys: `id uuid` (UUIDv7, time-ordered → good B-tree locality). Join tables use composite PKs. |
| DB-CONV-003 | Every table has `created_at timestamptz NOT NULL DEFAULT now()`; mutable tables have `updated_at`; versioned aggregates have `version int NOT NULL DEFAULT 0`. |
| DB-CONV-004 | Soft delete via `deleted_at timestamptz NULL` only on user-managed business entities (addresses, categories, food items, customization groups/options, coupons, reviews, branches, zones). Unique constraints on soft-deletable tables are partial (`WHERE deleted_at IS NULL`). |
| DB-CONV-005 | Money: `bigint` minor units (`*_amount` / `*_paise`) + `currency char(3)` at aggregate level (orders, payments, refunds, ledger). Rates: `int` basis points (`rate_bps`). `CHECK (amount >= 0)` unless the column is a signed ledger amount. |
| DB-CONV-006 | Enums: PostgreSQL enums via Prisma for closed sets that change only with code (statuses, allergens — a closed regulatory list); lookup tables for admin-managed sets (cuisines). |
| DB-CONV-007 | Foreign keys on every reference, `ON DELETE RESTRICT` by default; `CASCADE` only for pure child rows that have no meaning alone (e.g., `cart_item_options`, `role_permissions`). |
| DB-CONV-008 | JSONB only for: provider raw payloads (webhooks, provider responses), audit before/after diffs, notification template variables, feature-flag rules, setting values (schema-validated), score breakdowns, device metadata. **Never** for core business data (items, prices, statuses, addresses). |
| DB-CONV-009 | No array columns for relationships or tag-like lists; these are child tables (e.g., `food_item_tags`, `customer_allergens`) so they can be indexed, constrained and joined. |
| DB-CONV-010 | Timestamps are `timestamptz` (UTC); local business times (operating hours) are `time` + branch timezone column. |
| DB-CONV-011 | Every status column has a matching `*_status_history` table or is covered by `audit_logs` for low-frequency entities. |

## 15.3 Entity inventory

Legend: **PK** primary key, **UQ** unique, **FK** foreign key, **CK** check, **IX** index, **S** soft delete, **H** immutable historical snapshot / append-only, **V** version column.

### 15.3.1 Identity, access, sessions

| Entity | Purpose | Key columns | Constraints / indexes |
|---|---|---|---|
| `users` | Account identity | id, email citext NULL, phone (E.164) NULL, full_name, status (PENDING_VERIFICATION, ACTIVE, SUSPENDED, DEACTIVATED, ANONYMIZED), email_verified_at, phone_verified_at, token_version, permission_version, suspended_until, suspension_reason, deletion_scheduled_at, locale, avatar_file_id | UQ(email) WHERE status ≠ ANONYMIZED; UQ(phone) WHERE status ≠ ANONYMIZED; CK(email IS NOT NULL OR phone IS NOT NULL) |
| `user_credentials` | Password hash kept out of `users` selects | user_id PK/FK, password_hash, password_updated_at, algo_params | Never selected by default repositories |
| `oauth_accounts` | Linked Google/Apple identities | id, user_id, provider, provider_user_id, email | UQ(provider, provider_user_id) |
| `roles` | Platform roles (CUSTOMER, RESTAURANT_OWNER, DELIVERY_PARTNER, SUPPORT_AGENT, ADMIN, SUPER_ADMIN, custom) | id, key, name, is_system, app_scope | UQ(key) |
| `permissions` | Permission catalog `resource:action` | id, key, description, scope_type (PLATFORM, RESTAURANT) | UQ(key) |
| `role_permissions` | Role ↔ permission | role_id, permission_id | PK(role_id, permission_id) |
| `user_roles` | Platform role assignments | user_id, role_id, granted_by, granted_at | PK(user_id, role_id) |
| `user_sessions` | Device sessions | id, user_id, app, status (ACTIVE, REVOKED, EXPIRED), revoke_reason, ip, user_agent, device_label, created_at, last_active_at, idle_expires_at, absolute_expires_at, reauth_at, mfa_verified_at | IX(user_id, status); IX(absolute_expires_at) |
| `refresh_tokens` | Token family members (hash only) | id, session_id, token_hash bytea, parent_id, status (ACTIVE, ROTATED, REVOKED), issued_at, rotated_at, expires_at | UQ(token_hash); partial UQ(session_id) WHERE status = 'ACTIVE' (one active token per session) |
| `login_attempts` | Brute-force analytics | id, identifier_hash, user_id NULL, ip, app, outcome, reason, created_at | IX(identifier_hash, created_at); IX(ip, created_at); retention 90 d |
| `otp_codes` | OTP challenges | id, destination_hash, purpose, code_hmac, attempts, max_attempts, expires_at, consumed_at, user_id NULL | IX(destination_hash, purpose, created_at); CK(attempts ≤ max_attempts) |
| `verification_tokens` | Email verify, password reset, invitations, MFA login tokens | id, user_id, purpose, token_hash, expires_at, used_at | UQ(token_hash) |
| `mfa_factors` | TOTP secrets (encrypted) | id, user_id, type, secret_encrypted, confirmed_at | UQ(user_id, type) |
| `mfa_recovery_codes` | Hashed recovery codes | id, user_id, code_hash, used_at | — |
| `legal_documents` | Terms/privacy versions | id, type, version, content_file_id / markdown, is_material, published_at | UQ(type, version) |
| `user_consents` | Acceptance records (H) | id, user_id, legal_document_id, accepted_at, ip, user_agent | UQ(user_id, legal_document_id) |
| `push_subscriptions` | Web Push endpoints | id, user_id, session_id, endpoint, p256dh, auth, created_at | UQ(endpoint); FK session ON DELETE CASCADE |
| `idempotency_keys` | Request dedupe | key, user_id, method, path, request_hash, status (IN_PROGRESS, COMPLETED), response_code, response_body jsonb, expires_at | PK(user_id, key); IX(expires_at) |

### 15.3.2 Customers, addresses, geo

| Entity | Purpose | Key columns | Constraints / indexes |
|---|---|---|---|
| `customer_profiles` | Customer-specific data | user_id PK, veg_only_default, cod_blocked, cod_refusal_count, orders_delivered_count, first_order_at | — |
| `customer_dietary_preferences` | Preferred dietary tags | user_id, tag | PK(user_id, tag) |
| `customer_allergens` | Allergens to warn about | user_id, allergen | PK(user_id, allergen) |
| `customer_addresses` (S) | Saved addresses | id, user_id, label (HOME, WORK, OTHER), custom_label, line1, line2, landmark, area, city, state, pincode, location geography(Point), contact_name, contact_phone, instructions, is_default | partial UQ(user_id) WHERE is_default AND deleted_at IS NULL; partial UQ(user_id, label) WHERE label IN (HOME, WORK) AND deleted_at IS NULL; GiST(location); CK(pincode ~ '^[1-9][0-9]{5}$') |
| `zones` (S) | Delivery zones | id, name, city, polygon geography(Polygon), status (ACTIVE, SUSPENDED, INACTIVE), suspension_reason, max_delivery_radius_m, surge_amount, surge_until, rain_mode | GiST(polygon); exclusion constraint preventing overlapping ACTIVE zones (via trigger using `ST_Intersects`) |
| `geocode_cache` | Provider result cache | key (rounded coords or query hash), result jsonb, provider, expires_at | PK(key) |
| `search_history` | Customer queries | id, user_id, query, normalized, created_at | IX(user_id, created_at DESC); retention 180 d |
| `search_query_stats` | Trending aggregation | zone_id, normalized, hour, count, distinct_users | PK(zone_id, normalized, hour) |
| `favorite_restaurants` | Favorites | user_id, restaurant_id, created_at | PK(user_id, restaurant_id) |
| `favorite_items` | Favorites | user_id, food_item_id, created_at | PK(user_id, food_item_id) |

### 15.3.3 Restaurants

| Entity | Purpose | Key columns | Constraints / indexes |
|---|---|---|---|
| `restaurants` | Brand / legal entity | id, brand_name, slug, legal_name, entity_type, pan_encrypted + pan_last4, gstin, fssai_number, fssai_expires_on, description, logo_file_id, cover_file_id, onboarding_status (DRAFT, SUBMITTED, UNDER_REVIEW, CHANGES_REQUESTED, APPROVED, REJECTED), status (ACTIVE, SUSPENDED, DEACTIVATED), cod_enabled, pure_veg, rating_avg_bps, rating_count, approved_at, approved_by | UQ(slug); IX(onboarding_status); trigram IX(brand_name) |
| `restaurant_application_reviews` (H) | Review comments per submission | id, restaurant_id, submission_no, reviewer_id, decision, comments jsonb (field → comment), created_at | IX(restaurant_id) |
| `restaurant_documents` | KYC documents | id, restaurant_id, type (FSSAI, PAN, GST, BANK_PROOF, MENU, OTHER), file_id, status (PENDING, VERIFIED, REJECTED), expires_on, reviewer_note | IX(restaurant_id, type) |
| `restaurant_bank_accounts` | Payout destination | id, restaurant_id, holder_name, account_number_encrypted, account_last4, ifsc, status (PENDING_VERIFICATION, VERIFIED, REJECTED, SUPERSEDED), verified_at | partial UQ(restaurant_id) WHERE status = 'VERIFIED' |
| `restaurant_change_requests` | Legal/tax/bank change workflow | id, restaurant_id, type, payload_encrypted jsonb, status, requested_by, decided_by, decided_at, reason | IX(status) |
| `cuisines` | Admin-managed list | id, slug, name, image_file_id, is_active | UQ(slug) |
| `restaurant_cuisines` | Brand ↔ cuisines | restaurant_id, cuisine_id, is_primary, position | PK(restaurant_id, cuisine_id) |
| `branches` (S, V) | Orderable outlets | id, restaurant_id, zone_id, name, address fields, location geography(Point), timezone, delivery_radius_m, status (PENDING_APPROVAL, ACTIVE, SUSPENDED, DEACTIVATED), is_open_manual (bool), paused_until, pause_reason, default_prep_minutes, rush_extra_minutes, rush_until, min_order_amount, max_order_amount, price_for_two, packaging_fee_mode, packaging_fee_amount, accept_timeout_streak, menu_version, rating_avg_bps, rating_count, avg_prep_minutes_14d | GiST(location); IX(zone_id, status); CK(delivery_radius_m BETWEEN 500 AND 15000); CK(default_prep_minutes BETWEEN 5 AND 90) |
| `branch_operating_hours` | Weekly slots | id, branch_id, weekday (0–6), opens_at time, closes_at time, crosses_midnight (generated) | IX(branch_id, weekday); CK(opens_at <> closes_at); max 3 per weekday (trigger) |
| `branch_holidays` | Closures | id, branch_id, starts_at, ends_at, reason | CK(ends_at > starts_at); IX(branch_id, starts_at) |
| `branch_status_events` (H) | Open/close/pause log | id, branch_id, event (OPENED, CLOSED, PAUSED, RESUMED, AUTO_PAUSED, SUSPENDED…), reason, actor_id, until, created_at | IX(branch_id, created_at) |
| `restaurant_members` | Restaurant-scoped roles | id, restaurant_id, user_id, role (OWNER, MANAGER, ORDER_MANAGER, KITCHEN, STAFF), status (ACTIVE, SUSPENDED, REMOVED), all_branches bool | UQ(restaurant_id, user_id) WHERE status <> 'REMOVED'; partial UQ(restaurant_id) WHERE role='OWNER' AND status='ACTIVE' (single owner) |
| `restaurant_member_branches` | Branch scope | member_id, branch_id | PK(member_id, branch_id) |
| `restaurant_member_permissions` | Per-member grants/denials (ADV) | member_id, permission_id, effect (ALLOW, DENY) | PK(member_id, permission_id) |
| `restaurant_invitations` | Staff invitations | id, restaurant_id, invited_by, phone/email, role, branch_ids via child table, token_hash, status, expires_at | UQ(token_hash) |
| `restaurant_invitation_branches` | Invitation branch scope | invitation_id, branch_id | PK |
| `commission_plans` (H-versioned) | Default commission | id, name, rate_bps, effective_from, created_by | IX(effective_from) |
| `restaurant_commission_overrides` | Per-restaurant commission | id, restaurant_id, rate_bps, effective_from, created_by | UQ(restaurant_id, effective_from) |

### 15.3.4 Menu

| Entity | Purpose | Key columns | Constraints / indexes |
|---|---|---|---|
| `menu_categories` (S) | Restaurant categories | id, restaurant_id, name, description, position, is_active | partial UQ(restaurant_id, lower(name)) WHERE deleted_at IS NULL |
| `food_items` (S, V) | Items | id, restaurant_id, category_id, name, description, base_price_amount, discounted_price_amount NULL, dietary_marker (VEG, NON_VEG, EGG), spice_level (0–3) NULL, serving_size, prep_minutes, calories NULL, is_bestseller, is_recommended, is_todays_special, is_featured, is_combo, packaging_fee_amount NULL, search_vector tsvector (generated: name A, description C), position | CK(base_price_amount BETWEEN 100 AND 10000000); CK(discounted_price_amount IS NULL OR discounted_price_amount < base_price_amount); GIN(search_vector); GIN trigram(name); IX(category_id, position) |
| `food_item_tags` | Dietary tags | food_item_id, tag (VEGAN, JAIN, GLUTEN_FREE, DAIRY_FREE, SPICY, KETO, HIGH_PROTEIN) | PK |
| `food_item_allergens` | Allergens | food_item_id, allergen (GLUTEN, CRUSTACEANS, EGGS, FISH, PEANUTS, SOY, MILK, TREE_NUTS, CELERY, MUSTARD, SESAME, SULPHITES, LUPIN, MOLLUSCS) | PK |
| `food_item_ingredients` | Ingredient list (display) | id, food_item_id, name, position | — |
| `food_item_images` | Images | id, food_item_id, file_id, position | UQ(food_item_id, position) |
| `food_item_variants` (S) | Sizes/portions | id, food_item_id, name, price_amount, is_default, position | partial UQ(food_item_id) WHERE is_default AND deleted_at IS NULL |
| `customization_groups` (S) | Reusable groups | id, restaurant_id, name, min_select, max_select, is_required (generated min>0) | CK(min_select ≥ 0 AND max_select ≥ min_select AND max_select ≥ 1) |
| `customization_options` (S) | Options | id, group_id, name, price_delta_amount, dietary_marker, is_default, position | CK(price_delta_amount ≥ 0) |
| `food_item_customization_groups` | Attachment | food_item_id, group_id, variant_id NULL, position | UQ(food_item_id, group_id, variant_id) |
| `branch_item_availability` | Branch-level availability override | branch_id, food_item_id, is_available, unavailable_until NULL, updated_by | PK(branch_id, food_item_id) — absence = available |
| `branch_option_availability` | Option availability | branch_id, option_id, is_available, unavailable_until | PK |
| `branch_item_stock` (V) | Stock counts (CORE) | branch_id, food_item_id, quantity | PK; CK(quantity ≥ 0) |
| `availability_schedules` | Item/category time windows (CORE) | id, target_type (ITEM, CATEGORY), target_id, weekday, starts_at, ends_at | IX(target_type, target_id) |
| `combo_components` | Combo composition (CORE) | combo_item_id, component_item_id, quantity, variant_id NULL | PK(combo_item_id, component_item_id) |

### 15.3.5 Cart, checkout, pricing config, coupons, promotions

| Entity | Purpose | Key columns | Constraints / indexes |
|---|---|---|---|
| `carts` (V) | Customer cart | id, user_id, branch_id NULL, status (ACTIVE, CONVERTED, EXPIRED, ABANDONED), coupon_id NULL, instructions, no_cutlery, last_activity_at | partial UQ(user_id) WHERE status='ACTIVE' (one active cart); IX(last_activity_at) |
| `cart_items` | Lines | id, cart_id, food_item_id, variant_id NULL, quantity, instructions, config_hash | UQ(cart_id, config_hash); CK(quantity BETWEEN 1 AND 20) |
| `cart_item_options` | Selected options | cart_item_id, option_id | PK; FK cart_item ON DELETE CASCADE |
| `checkout_sessions` | Priced snapshot | id, user_id, cart_id, cart_hash, address_id (address re-read and snapshotted into `order_addresses` at confirm), payment_method, use_wallet, tip_amount, quote jsonb (derived, re-computable cache), payable_amount, fee_schedule_id, tax_rule_set_id, status (OPEN, CONFIRMED, EXPIRED), expires_at | IX(user_id, status); quote JSONB is a *cache* — authoritative amounts are recomputed at confirm |
| `fee_schedules` (H) | Effective-dated fees | id, zone_id NULL, platform_fee_amount, small_order_threshold_amount, small_order_fee_amount, delivery_fee_slabs via child, packaging_cap_amount, surge_cap_amount, effective_from, created_by | IX(zone_id, effective_from) |
| `delivery_fee_slabs` | Distance slabs | fee_schedule_id, from_m, to_m, fee_amount | PK(fee_schedule_id, from_m); CK(to_m > from_m) |
| `tax_rules` (H) | Effective-dated tax rates | id, component (FOOD, PACKAGING, DELIVERY_FEE, PLATFORM_FEE, SMALL_ORDER_FEE), tax_code (CGST, SGST, IGST, GST), rate_bps, collected_by (PLATFORM, RESTAURANT), effective_from | IX(component, effective_from) |
| `coupons` (S, V) | Coupon definitions | id, code citext, description, discount_type (FLAT, PERCENT, FREE_DELIVERY), value, max_discount_amount, min_subtotal_amount, starts_at, ends_at, usage_limit_total, usage_limit_per_user, used_count, reserved_count, user_segment (ALL, NEW_USERS, TARGETED), payment_method_restriction NULL, funding (PLATFORM, RESTAURANT, SHARED), restaurant_share_bps, stackable_with_promotion, visibility (PUBLIC, HIDDEN), status | partial UQ(code) WHERE deleted_at IS NULL; CK(ends_at > starts_at); CK(used_count + reserved_count ≤ usage_limit_total) when limit set |
| `coupon_restaurants` / `coupon_zones` / `coupon_users` | Targeting | coupon_id + target id | PK each |
| `coupon_redemptions` | Reservation/redemption | id, coupon_id, user_id, order_id, status (RESERVED, REDEEMED, RELEASED), discount_amount, created_at | UQ(order_id); IX(coupon_id, user_id, status) |
| `promotions` (S) | Automatic promotions | id, scope (PLATFORM, RESTAURANT), restaurant_id NULL, type (PERCENT_OFF, FLAT_OFF, FREE_DELIVERY, BOGO), value, max_discount_amount, min_subtotal_amount, starts_at, ends_at, new_customers_only, funding, status (DRAFT, PENDING_APPROVAL, ACTIVE, ENDED) | IX(restaurant_id, status, ends_at) |
| `promotion_branches` / `promotion_items` | Scope | promotion_id + branch/item | PK |
| `banners` (S) | Home banners | id, title, image_file_id, target_route, zone_id NULL, starts_at, ends_at, position | — |
| `collections` / `collection_items` | Curated lists | id, slug, title, …; collection_id, restaurant_id, position | UQ(slug) |

### 15.3.6 Orders

| Entity | Purpose | Key columns | Constraints / indexes |
|---|---|---|---|
| `orders` (V) | Order aggregate | id, number, user_id, restaurant_id, branch_id, checkout_session_id, status, refund_status, payment_method, currency, items_subtotal_amount, discount_total_amount, fees_total_amount, tax_total_amount, tip_amount, wallet_applied_amount, total_amount, payable_amount, fee_schedule_id, commission_rate_bps (snapshot), coupon_id NULL, delivery_otp_hash, otp_attempts, contactless, delivery_instructions, contact_name, contact_phone, no_cutlery, cooking_instructions, prep_minutes, placed_at, accepted_at, preparing_at, ready_by, ready_at, picked_up_at, delivered_at, cancelled_at, eta_min_at, eta_max_at, failure_reason | UQ(number); UQ(checkout_session_id); IX(user_id, created_at DESC); IX(branch_id, status, created_at); partial IX(status) WHERE status NOT IN terminal; CK(payable_amount = total_amount − wallet_applied_amount); CK(total_amount ≥ 0) |
| `order_addresses` (H) | Delivery address snapshot | order_id PK, line1, line2, landmark, area, city, state, pincode, location geography(Point), source_address_id NULL | — |
| `order_items` (H) | Item snapshot | id, order_id, food_item_id (ref, nullable FK SET NULL never — RESTRICT with soft delete), item_name, variant_name, dietary_marker, unit_price_amount (incl. variant), options_amount, item_discount_amount, quantity, line_total_amount, tax_rate_bps, instructions | CK(quantity BETWEEN 1 AND 20); IX(order_id) |
| `order_item_options` (H) | Option snapshot | id, order_item_id, option_id, group_name, option_name, price_delta_amount | — |
| `order_price_components` (H) | Breakdown lines | id, order_id, type (ITEMS_SUBTOTAL, ITEM_DISCOUNT, PROMOTION, COUPON, PACKAGING, DELIVERY_FEE, SURGE, SMALL_ORDER_FEE, PLATFORM_FEE, TAX, TIP, WALLET), code, label, amount (signed), tax_code NULL, rate_bps NULL, funded_by (PLATFORM, RESTAURANT, SHARED, CUSTOMER) | IX(order_id) |
| `order_status_history` (H) | Timeline | id, order_id, from_status, to_status, actor_type, actor_id, reason, metadata jsonb, created_at | IX(order_id, created_at) |
| `order_cancellations` (H) | Cancellation facts | order_id PK, initiator_type, initiator_id, reason_code, note, fault (CUSTOMER, RESTAURANT, PARTNER, PLATFORM, PAYMENT), fee_amount, refund_amount, quote_id | — |
| `order_issues` | Customer-reported issues | id, order_id, type, description, status, ticket_id, requested_refund_amount, resolution | IX(order_id) |
| `order_issue_items` | Affected items | issue_id, order_item_id, quantity | PK |
| `order_issue_photos` | Evidence | issue_id, file_id | PK |
| `invoices` (H) | Tax invoices | id, order_id, issuer (RESTAURANT, PLATFORM), series, number, financial_year, file_id, issued_at | UQ(series, financial_year, number) |

### 15.3.7 Payments, refunds, ledger, payouts

| Entity | Purpose | Key columns | Constraints / indexes |
|---|---|---|---|
| `payments` (V) | Payment per order per method | id, order_id, method (ONLINE, COD, WALLET), provider (RAZORPAY, STRIPE, MOCK, NONE), provider_order_id, amount, currency, status, captured_amount, refunded_amount, captured_at, instrument_summary (masked), failure_code, failure_reason | IX(order_id); UQ(provider, provider_order_id); CK(refunded_amount ≤ captured_amount); CK(captured_amount ≤ amount) unless anomaly flagged |
| `payment_attempts` (H) | Provider payment attempts | id, payment_id, provider_payment_id, status, amount, method_detail, error_code, raw jsonb, created_at | UQ(provider_payment_id) |
| `payment_webhook_events` (H) | Raw webhook log | id, provider, event_id, event_type, signature_valid, payload jsonb, received_at, processed_at, processing_status, error | UQ(provider, event_id); IX(processing_status) |
| `refunds` (V) | Refunds | id, order_id, payment_id NULL (wallet-only), amount, destination (SOURCE, WALLET), reason_code, note, initiator_type, initiator_id, cost_bearer, status, provider_refund_id, attempts, next_attempt_at, completed_at | UQ(provider_refund_id); IX(status, next_attempt_at) |
| `refund_items` | Item-level refund detail | refund_id, order_item_id, quantity, amount | PK |
| `ledger_accounts` | Accounts | id, owner_type (CUSTOMER, RESTAURANT, PARTNER, PLATFORM), owner_id NULL, type (CUSTOMER_WALLET, CUSTOMER_WALLET_HOLD, CUSTOMER_ORDER_LIABILITY, RESTAURANT_PAYABLE, PARTNER_PAYABLE, PARTNER_CASH_IN_HAND, PLATFORM_REVENUE_COMMISSION, PLATFORM_REVENUE_FEES, PLATFORM_PROMO_EXPENSE, PLATFORM_REFUND_EXPENSE, PLATFORM_DELIVERY_COST, GATEWAY_CLEARING, REFUND_CLEARING, TAX_PAYABLE, PAYOUT_CLEARING, CASH_CLEARING, BANK) — chart of accounts illustrated in `docs/architecture/PAYMENT-ARCHITECTURE.md` §4, currency, balance (cached), version | UQ(owner_type, owner_id, type, currency); CK on wallet accounts balance ≥ 0 |
| `ledger_transactions` (H) | Balanced journal | id, type (ORDER_PAYMENT, ORDER_SETTLEMENT, REFUND, WALLET_CREDIT, WALLET_HOLD, WALLET_RELEASE, COD_COLLECTION, CASH_DEPOSIT, PAYOUT, ADJUSTMENT, INCENTIVE), reference_type, reference_id, description, created_by, created_at | UQ(type, reference_type, reference_id, idempotency_suffix) — prevents double posting |
| `ledger_entries` (H) | Debit/credit lines | id, transaction_id, account_id, amount (signed bigint), created_at | IX(account_id, created_at); trigger: Σ amount per transaction = 0 (deferred constraint) |
| `wallet_credit_lots` | Credit expiry tracking | id, account_id, source (REFUND, PROMO, GOODWILL), amount, remaining, expires_at | IX(account_id, expires_at) |
| `restaurant_settlements` | Weekly statements | id, restaurant_id, period_start, period_end, gross_amount, commission_amount, discounts_amount, taxes_amount, adjustments_amount, net_amount, status, payout_id | UQ(restaurant_id, period_start) |
| `partner_earnings` (H) | Per-delivery earnings | id, partner_id, delivery_id, base_amount, distance_amount, wait_amount, surge_amount, tip_amount, total_amount, pay_plan_id | UQ(delivery_id) |
| `partner_pay_plans` (H-versioned) | Pay formula params | id, zone_id NULL, base_amount, per_km_amount, free_km_m, wait_after_minutes, per_wait_minute_amount, rain_bonus_amount, effective_from | — |
| `incentive_programs` / `incentive_progress` | Incentives (CORE) | program rules; partner_id, program_id, period, progress, achieved_at, credited_txn_id | UQ(program_id, partner_id, period) |
| `payout_batches` | Batches | id, type (RESTAURANT, PARTNER), period_start, period_end, status, created_by, approved_by, approved_at | UQ(type, period_start) |
| `payouts` | Batch lines | id, batch_id, payee_type, payee_id, bank_account_id, amount, status, utr, failure_reason, paid_at | UQ(batch_id, payee_type, payee_id); CK(amount > 0) |
| `reconciliation_runs` / `reconciliation_exceptions` | Recon | run date, provider, counts; exception type, refs, status, resolution | — |

### 15.3.8 Delivery partners & deliveries

| Entity | Purpose | Key columns | Constraints / indexes |
|---|---|---|---|
| `delivery_partners` | Partner profile | id, user_id, onboarding_status, status (ACTIVE, SUSPENDED, DEACTIVATED), date_of_birth, pan_encrypted + pan_last4, aadhaar_last4, home_zone_id, photo_file_id, emergency_contact_name, emergency_contact_relation, emergency_contact_phone, guidelines_version_ack, availability_state (persisted copy), last_location geography(Point) NULL, last_location_at, cod_enabled | UQ(user_id); GiST(last_location) |
| `partner_documents` | KYC docs | id, partner_id, type (DL_FRONT, DL_BACK, RC, INSURANCE, PAN, ID_PROOF, BANK_PROOF, PHOTO), file_id, status, number_last4, expires_on, reviewer_note | IX(partner_id, type) |
| `partner_vehicles` (S) | Vehicles | id, partner_id, type (BICYCLE, E_BIKE, MOTORCYCLE, SCOOTER), registration_number, status (PENDING, VERIFIED, REJECTED), is_active | partial UQ(partner_id) WHERE is_active; partial UQ(registration_number) WHERE status='VERIFIED' |
| `partner_bank_accounts` | Payout destination | like restaurant_bank_accounts | partial UQ(partner_id) WHERE status='VERIFIED' |
| `partner_online_sessions` (H) | Online time | id, partner_id, started_at, ended_at, end_reason | IX(partner_id, started_at) |
| `partner_stats` | Rolling metrics for ranking | partner_id PK, acceptance_rate_bps_30d, completion_rate_bps_30d, on_time_rate_bps_30d, rating_avg_bps, rating_count, deliveries_today, last_delivery_completed_at, consecutive_missed_offers | — |
| `deliveries` (V) | Delivery aggregate | id, order_id, branch_id, partner_id NULL, status, escalated, dispatch_starts_at, search_round, pickup_code, assigned_at, arrived_restaurant_at, picked_up_at, arrived_customer_at, delivered_at, distance_pickup_m, distance_drop_m, proof_type (OTP, PHOTO, ADMIN), proof_file_id NULL, failure_reason | UQ(order_id) (one delivery per order; reassignment happens inside it via `delivery_assignments`); partial UQ(partner_id) WHERE status IN (ASSIGNED, AT_RESTAURANT, EN_ROUTE_TO_CUSTOMER, AT_CUSTOMER) (max 1 active per partner in MVP) |
| `delivery_assignments` (H) | Offers | id, delivery_id, partner_id, round, rank, score, score_breakdown jsonb, distance_to_pickup_m, status (OFFERED, ACCEPTED, REJECTED, EXPIRED, WITHDRAWN, RELEASED, REVOKED), offered_at, expires_at, displayed_at, responded_at, reject_reason, manual (bool), assigned_by | partial UQ(delivery_id) WHERE status='ACCEPTED'; partial UQ(partner_id) WHERE status='OFFERED'; IX(delivery_id, partner_id) |
| `delivery_status_history` (H) | Delivery timeline | id, delivery_id, from_status, to_status, actor_type, actor_id, location geography(Point) NULL, distance_to_target_m, flagged, created_at | IX(delivery_id, created_at) |
| `delivery_locations` (H, partitioned monthly) | Sampled trail | id, delivery_id, partner_id, location geography(Point), accuracy_m, heading, speed, recorded_at (device), received_at | IX(delivery_id, received_at); retention §20 |
| `delivery_routes` | Cached route geometry | delivery_id, leg (TO_RESTAURANT, TO_CUSTOMER), polyline, distance_m, duration_s, computed_at, provider | PK(delivery_id, leg) |
| `delivery_otp_attempts` | OTP attempt log | id, delivery_id, success, created_at | IX(delivery_id) |

### 15.3.9 Reviews, notifications, support, chat, platform

| Entity | Purpose | Key columns | Constraints / indexes |
|---|---|---|---|
| `reviews` (S) | Ratings | id, order_id, author_id, target_type (RESTAURANT, PARTNER, ITEM), restaurant_id NULL, branch_id NULL, partner_id NULL, food_item_id NULL, rating smallint, text, status (PUBLISHED, HIDDEN, REMOVED), edited_until | UQ(order_id, target_type, coalesce(food_item_id)) ; CK(rating BETWEEN 1 AND 5); CK exactly one target id set per target_type |
| `review_tags` / `review_photos` | Detail | review_id, tag / file_id | PK |
| `review_responses` | Restaurant reply | review_id PK, author_id, text, editable_until | — |
| `review_reports` | Moderation reports | id, review_id, reporter_id, reason, status | UQ(review_id, reporter_id) |
| `notification_templates` (H-versioned) | Templates | id, key, channel, locale, version, subject, body, variables schema jsonb, is_transactional, active | UQ(key, channel, locale, version) |
| `notifications` | In-app inbox | id, user_id, app, category, title, body, deep_link, data jsonb, read_at, deleted_at, created_at | IX(user_id, created_at DESC); partial IX(user_id) WHERE read_at IS NULL |
| `notification_deliveries` (H) | Channel attempts | id, notification_event_id, user_id, channel, provider, provider_message_id, status, attempts, last_error, sent_at | IX(status) |
| `notification_preferences` | Opt-ins | user_id, category, channel, enabled | PK(user_id, category, channel) |
| `support_tickets` | Tickets | id, number, requester_id, requester_type, category, priority, status (OPEN, PENDING_CUSTOMER, PENDING_INTERNAL, RESOLVED, CLOSED), order_id NULL, assignee_id, sla_due_at, resolved_at, csat | UQ(number); IX(status, priority, sla_due_at) |
| `support_ticket_messages` | Messages | id, ticket_id, author_id, author_type, body, is_internal, created_at | IX(ticket_id, created_at) |
| `support_ticket_attachments` | Files | message_id, file_id | PK |
| `complaints` | Complaints (CORE) | id, against_type, against_id, order_id, ticket_id, category, severity, status, resolution, penalty_amount | IX(against_type, against_id) |
| `disputes` | Disputes (CORE) | id, order_id, raised_by, status, outcome, refund_id, decided_by | — |
| `faqs`, `support_macros` | Content | — | — |
| `chat_conversations` / `chat_participants` / `chat_messages` | Chat (ADV) | order-scoped conversations | — |
| `files` | Object metadata | id, owner_user_id, purpose, bucket, object_key, mime_type, size_bytes, sha256, width, height, visibility (PUBLIC, PRIVATE), status (UPLOADED, ATTACHED, DELETED), scan_status | UQ(bucket, object_key) |
| `audit_logs` (H, partitioned monthly) | Audit trail | id, actor_user_id, actor_roles, session_id, action, target_type, target_id, reason, before jsonb, after jsonb, ip, user_agent, request_id, sensitivity, created_at | IX(target_type, target_id, created_at); IX(actor_user_id, created_at); IX(action, created_at); UPDATE/DELETE revoked |
| `platform_settings` / `platform_setting_history` | Config | key PK, value jsonb, schema_version, updated_by / history rows | — |
| `feature_flags` | Flags | key PK, description, enabled, rules jsonb, updated_by | — |
| `approval_requests` | Maker-checker (CORE) | id, action, payload jsonb, requested_by, status, decided_by, decided_at | CK(decided_by <> requested_by) |
| `ops_alerts` | Alerts | id, type, severity, ref_type, ref_id, status, dedupe_key, acknowledged_by | partial UQ(dedupe_key) WHERE status='OPEN' |
| `report_exports` | Async exports | id, requested_by, type, params jsonb, status, file_id, expires_at | — |
| `outbox_events` | Transactional outbox | id (bigserial sequence), event_id uuid, aggregate_type, aggregate_id, aggregate_version, event_type, payload jsonb, created_at, published_at NULL, attempts | IX(published_at) WHERE published_at IS NULL; UQ(event_id) |
| `analytics_branch_hourly` / `analytics_platform_daily` / `analytics_item_daily` | Pre-aggregates | dimension keys + metrics | PK on dimensions |

**Entity count:** ~125 tables (including join tables), satisfying and extending the master prompt's starting list (mapping: `user_profiles` → `users` + `customer_profiles`; `restaurant_owners` → `restaurant_members` with role OWNER; `restaurant_inventory` → `branch_item_availability` + `branch_item_stock`; `delivery_partner_availability` → Redis state + `partner_online_sessions` + `delivery_partners.availability_state`; `wallets` / `wallet_transactions` / `transactions` / `earnings` → ledger tables + `partner_earnings`; `sessions` → `user_sessions`).

## 15.4 Relationships (summary)

- `users` 1—1 `customer_profiles`, 1—0..1 `delivery_partners`, 1—* `restaurant_members` *—1 `restaurants`.
- `restaurants` 1—* `branches`; `restaurants` 1—* `menu_categories` 1—* `food_items`; `food_items` 1—* `food_item_variants`; `food_items` *—* `customization_groups` (via attachment); `customization_groups` 1—* `customization_options`.
- `branches` *—1 `zones`; branch-level availability rows reference (branch, item).
- `users` 1—0..1 active `carts` 1—* `cart_items` 1—* `cart_item_options`.
- `orders` *—1 `users`, *—1 `branches`, 1—1 `checkout_sessions`, 1—1 `order_addresses`, 1—* `order_items` 1—* `order_item_options`, 1—* `order_price_components`, 1—* `order_status_history`, 1—0..1 `order_cancellations`, 1—* `payments` 1—* `payment_attempts`, 1—* `refunds`, 1—1 `deliveries` 1—* `delivery_assignments`, 1—* `reviews`.
- `deliveries` *—0..1 `delivery_partners`; `delivery_partners` 1—* `partner_vehicles`, `partner_documents`, `partner_earnings`.
- Ledger: `ledger_transactions` 1—* `ledger_entries` *—1 `ledger_accounts`; references to orders/refunds/payouts are polymorphic (`reference_type`, `reference_id`) with application-level integrity + reconciliation checks (deliberate: ledger must remain append-only and decoupled from domain table lifecycles).

## 15.5 Integrity, transactions and concurrency

| ID | Requirement |
|---|---|
| DB-INT-001 | Order creation, state transitions, payment capture application, refund creation, assignment acceptance, coupon reservation, wallet hold/debit, and ledger posting each execute in a single DB transaction (isolation READ COMMITTED + explicit `SELECT … FOR UPDATE` on contended rows). |
| DB-INT-002 | Contention points and their locks: order row (transitions), coupon row (usage counters), wallet ledger account row (balance), delivery + offer rows (assignment), payment row (capture/refund), branch_item_stock rows (stock). Lock ordering is fixed (order → payment → coupon → wallet → stock) to prevent deadlocks; deadlock/serialization errors are retried (E29). |
| DB-INT-003 | Business uniqueness enforced in the DB, not only in code: one active cart per user; one active refresh token per session; one ACCEPTED assignment per delivery; one OFFERED assignment per partner; one active delivery per partner (MVP); one order per checkout session; one webhook per (provider, event_id); one redemption per order; ledger transaction uniqueness per reference. |
| DB-INT-004 | Ledger balance invariant: Σ entries per transaction = 0 (deferred constraint trigger); wallet balance ≥ 0 (check on cached balance updated in same transaction). |
| DB-INT-005 | Referential integrity for historical snapshots: soft-deleted menu items remain referenced by `order_items.food_item_id`; snapshots contain all display/price data so orders render even if the item is later deleted. |
| DB-INT-006 | Outbox rows are inserted in the same transaction as the state change they describe. |

## 15.6 Historical snapshots (immutable)

These entities are **append-only**/immutable once written (application never updates; DB triggers reject updates on protected columns):
`order_items`, `order_item_options`, `order_price_components`, `order_addresses`, `order_status_history`, `order_cancellations`, `invoices`, `payment_attempts`, `payment_webhook_events`, `ledger_transactions`, `ledger_entries`, `partner_earnings`, `delivery_assignments` (after terminal status), `delivery_status_history`, `delivery_locations`, `user_consents`, `audit_logs`, `restaurant_application_reviews`, `branch_status_events`, effective-dated configs (`fee_schedules`, `tax_rules`, `commission_plans`, `partner_pay_plans`, `notification_templates` versions).

Order items preserve: item name, variant name, dietary marker, unit price, option names & prices, item discount, quantity, tax rate, line total — satisfying master prompt §13 (historical pricing never reconstructed from current menu data).

## 15.7 Indexing strategy

| Query | Index |
|---|---|
| Nearby serviceable branches | GiST on `branches.location` + `ST_DWithin(location, :point, delivery_radius_m)`; zone containment via GiST on `zones.polygon`; composite filter `(status)` |
| Menu load | `(restaurant_id, category_id, position)` on items; availability PK lookups |
| Search | GIN on `food_items.search_vector`, `restaurants.search_vector`; GIN trigram on names |
| Active orders per branch | `(branch_id, status, created_at)`; partial index on non-terminal statuses |
| Customer history | `(user_id, created_at DESC)` |
| Job sweeps | partial indexes on `status` + due timestamps (`payments` pending, `refunds` next_attempt_at, `outbox_events` unpublished) |
| Audit | `(target_type, target_id, created_at)`, `(actor_user_id, created_at)` per partition |
| Ledger | `(account_id, created_at)` |

Index additions are justified by query plans (`EXPLAIN ANALYZE` in performance tests, NFR-PERF-012).

## 15.8 Data lifecycle

| Data | Lifecycle |
|---|---|
| Carts | ACTIVE → CONVERTED (order) / EXPIRED (7 d inactivity) → deleted after 30 d. |
| Checkout sessions | OPEN (10 min) → CONFIRMED / EXPIRED. EXPIRED sessions are deleted after 7 d; CONFIRMED sessions are retained for as long as the order that references them. |
| Idempotency keys | 24 h then purged. |
| OTPs / verification tokens | Expire (5 min / 24 h / 30 min) → purged after 7 d. |
| Sessions & refresh tokens | ACTIVE → REVOKED/EXPIRED → purged 30 d after end. |
| Orders & financial records | Retained ≥ 8 years (tax/accounting — legal review), PII in snapshots minimized after 3 years (name → initials, phone removed, address coarse to area) — §20. |
| Delivery location trails | 90 days, then aggregated (distance only) and deleted. |
| Audit logs | 3 years online (partitioned), then archived to cold storage ≥ 8 years for financial/admin actions. |
| Notifications (in-app) | 180 days. |
| Webhook raw payloads | 1 year. |

## 15.9 Backup & recovery (DB-specific; NFR-BACKUP-* for targets)

- Continuous WAL archiving + daily base backups (managed PITR in production); retain 35 days of PITR, monthly snapshots 12 months.
- Logical dumps of configuration tables before each release migration.
- Quarterly restore drill into an isolated environment with automated integrity checks (row counts, ledger invariants).
- Migrations are forward-only in production; each migration has a tested rollback plan (expand/contract pattern for breaking changes).
