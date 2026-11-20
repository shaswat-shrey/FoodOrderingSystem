# Initial Entity-Relationship Diagrams

> Companion to SRS §15 ([DATABASE-REQUIREMENTS.md](../requirements/DATABASE-REQUIREMENTS.md)). Status: **Initial ERD, v0.1.0 (DRAFT)**. Column lists are abbreviated to keys and the most important attributes; the entity inventory in §15.3 is authoritative for columns and constraints. One diagram per domain keeps each readable; cross-domain links are shown as references at the edges.

## 1. Identity, access & sessions

```mermaid
erDiagram
  users ||--o| user_credentials : "has"
  users ||--o{ oauth_accounts : "links"
  users ||--o{ user_roles : "granted"
  roles ||--o{ user_roles : ""
  roles ||--o{ role_permissions : ""
  permissions ||--o{ role_permissions : ""
  users ||--o{ user_sessions : "logs in"
  user_sessions ||--o{ refresh_tokens : "token family"
  refresh_tokens |o--o| refresh_tokens : "parent"
  users ||--o{ otp_codes : ""
  users ||--o{ verification_tokens : ""
  users ||--o{ mfa_factors : ""
  users ||--o{ user_consents : ""
  legal_documents ||--o{ user_consents : ""
  user_sessions ||--o{ push_subscriptions : ""
  users {
    uuid id PK
    citext email UK
    text phone UK
    enum status
    int token_version
    int permission_version
  }
  user_sessions {
    uuid id PK
    uuid user_id FK
    enum app
    enum status
    timestamptz idle_expires_at
    timestamptz absolute_expires_at
  }
  refresh_tokens {
    uuid id PK
    uuid session_id FK
    bytea token_hash UK
    uuid parent_id FK
    enum status
  }
```

## 2. Restaurants, branches, staff

```mermaid
erDiagram
  restaurants ||--o{ branches : "operates"
  restaurants ||--o{ restaurant_documents : ""
  restaurants ||--o{ restaurant_bank_accounts : ""
  restaurants ||--o{ restaurant_change_requests : ""
  restaurants ||--o{ restaurant_application_reviews : ""
  restaurants ||--o{ restaurant_cuisines : ""
  cuisines ||--o{ restaurant_cuisines : ""
  restaurants ||--o{ restaurant_members : "employs"
  users ||--o{ restaurant_members : ""
  restaurant_members ||--o{ restaurant_member_branches : "scoped to"
  branches ||--o{ restaurant_member_branches : ""
  restaurants ||--o{ restaurant_invitations : ""
  branches ||--o{ branch_operating_hours : ""
  branches ||--o{ branch_holidays : ""
  branches ||--o{ branch_status_events : ""
  zones ||--o{ branches : "contains"
  restaurants ||--o{ restaurant_commission_overrides : ""
  restaurants {
    uuid id PK
    text brand_name
    text gstin
    text fssai_number
    enum onboarding_status
    enum status
  }
  branches {
    uuid id PK
    uuid restaurant_id FK
    uuid zone_id FK
    geography location
    int delivery_radius_m
    enum status
    timestamptz paused_until
    int menu_version
  }
  restaurant_members {
    uuid id PK
    uuid restaurant_id FK
    uuid user_id FK
    enum role
    bool all_branches
  }
  zones {
    uuid id PK
    geography polygon
    enum status
  }
```

## 3. Menu

```mermaid
erDiagram
  restaurants ||--o{ menu_categories : ""
  menu_categories ||--o{ food_items : "groups"
  food_items ||--o{ food_item_variants : "sizes"
  food_items ||--o{ food_item_images : ""
  food_items ||--o{ food_item_tags : ""
  food_items ||--o{ food_item_allergens : ""
  food_items ||--o{ food_item_ingredients : ""
  restaurants ||--o{ customization_groups : "reusable"
  customization_groups ||--o{ customization_options : ""
  food_items ||--o{ food_item_customization_groups : "attaches"
  customization_groups ||--o{ food_item_customization_groups : ""
  food_item_variants |o--o{ food_item_customization_groups : "variant-specific"
  branches ||--o{ branch_item_availability : ""
  food_items ||--o{ branch_item_availability : ""
  branches ||--o{ branch_option_availability : ""
  customization_options ||--o{ branch_option_availability : ""
  branches ||--o{ branch_item_stock : ""
  food_items ||--o{ combo_components : "combo of"
  food_items {
    uuid id PK
    uuid restaurant_id FK
    uuid category_id FK
    bigint base_price_amount
    bigint discounted_price_amount
    enum dietary_marker
    tsvector search_vector
  }
  customization_groups {
    uuid id PK
    int min_select
    int max_select
  }
  customization_options {
    uuid id PK
    uuid group_id FK
    bigint price_delta_amount
  }
```

## 4. Cart, checkout, pricing, coupons

```mermaid
erDiagram
  users ||--o{ carts : ""
  branches |o--o{ carts : "single branch"
  carts ||--o{ cart_items : ""
  cart_items ||--o{ cart_item_options : ""
  food_items ||--o{ cart_items : ""
  customization_options ||--o{ cart_item_options : ""
  carts ||--o{ checkout_sessions : ""
  customer_addresses ||--o{ checkout_sessions : ""
  fee_schedules ||--o{ delivery_fee_slabs : ""
  fee_schedules ||--o{ checkout_sessions : "priced with"
  coupons |o--o{ carts : "applied"
  coupons ||--o{ coupon_redemptions : ""
  coupons ||--o{ coupon_restaurants : ""
  coupons ||--o{ coupon_zones : ""
  coupons ||--o{ coupon_users : ""
  promotions ||--o{ promotion_branches : ""
  promotions ||--o{ promotion_items : ""
  carts {
    uuid id PK
    uuid user_id FK
    uuid branch_id FK
    enum status
    int version
  }
  checkout_sessions {
    uuid id PK
    uuid cart_id FK
    text cart_hash
    bigint payable_amount
    enum status
    timestamptz expires_at
  }
  coupons {
    uuid id PK
    citext code UK
    enum discount_type
    int used_count
    int reserved_count
  }
```

## 5. Orders, payments, refunds

```mermaid
erDiagram
  users ||--o{ orders : "places"
  branches ||--o{ orders : "fulfils"
  checkout_sessions ||--|| orders : "becomes"
  orders ||--|| order_addresses : "snapshot"
  orders ||--o{ order_items : "snapshot"
  order_items ||--o{ order_item_options : "snapshot"
  orders ||--o{ order_price_components : "breakdown"
  orders ||--o{ order_status_history : "timeline"
  orders ||--o| order_cancellations : ""
  orders ||--o{ order_issues : ""
  orders ||--o{ invoices : ""
  orders ||--o| coupon_redemptions : ""
  orders ||--o{ payments : ""
  payments ||--o{ payment_attempts : ""
  orders ||--o{ refunds : ""
  payments |o--o{ refunds : ""
  refunds ||--o{ refund_items : ""
  order_items ||--o{ refund_items : ""
  orders {
    uuid id PK
    text number UK
    uuid checkout_session_id UK
    enum status
    enum refund_status
    bigint total_amount
    bigint payable_amount
    int version
  }
  payments {
    uuid id PK
    uuid order_id FK
    enum method
    enum provider
    text provider_order_id
    enum status
    bigint captured_amount
    bigint refunded_amount
  }
  payment_webhook_events {
    uuid id PK
    text provider
    text event_id
    jsonb payload
  }
  refunds {
    uuid id PK
    uuid order_id FK
    bigint amount
    enum destination
    enum status
  }
```

## 6. Delivery partners, dispatch, tracking, earnings

```mermaid
erDiagram
  users ||--o| delivery_partners : "is"
  delivery_partners ||--o{ partner_documents : ""
  delivery_partners ||--o{ partner_vehicles : ""
  delivery_partners ||--o{ partner_bank_accounts : ""
  delivery_partners ||--o{ partner_online_sessions : ""
  delivery_partners ||--|| partner_stats : ""
  orders ||--|| deliveries : "fulfilled by"
  delivery_partners |o--o{ deliveries : "assigned"
  deliveries ||--o{ delivery_assignments : "offers"
  delivery_partners ||--o{ delivery_assignments : ""
  deliveries ||--o{ delivery_status_history : ""
  deliveries ||--o{ delivery_locations : "trail"
  deliveries ||--o{ delivery_routes : ""
  deliveries ||--o| partner_earnings : ""
  partner_pay_plans ||--o{ partner_earnings : "computed with"
  deliveries {
    uuid id PK
    uuid order_id UK
    uuid partner_id FK
    enum status
    bool escalated
    int search_round
  }
  delivery_assignments {
    uuid id PK
    uuid delivery_id FK
    uuid partner_id FK
    int round
    int rank
    enum status
    timestamptz expires_at
  }
```

## 7. Ledger, settlements, payouts

```mermaid
erDiagram
  ledger_transactions ||--|{ ledger_entries : "balanced (sum = 0)"
  ledger_accounts ||--o{ ledger_entries : ""
  ledger_accounts ||--o{ wallet_credit_lots : ""
  restaurants ||--o{ restaurant_settlements : ""
  payout_batches ||--o{ payouts : ""
  restaurant_settlements |o--o| payouts : "paid by"
  ledger_accounts {
    uuid id PK
    enum owner_type
    uuid owner_id
    enum type
    bigint balance
  }
  ledger_transactions {
    uuid id PK
    enum type
    text reference_type
    uuid reference_id
  }
  ledger_entries {
    uuid id PK
    uuid transaction_id FK
    uuid account_id FK
    bigint amount
  }
```

Ledger references to orders, refunds and payouts are polymorphic (`reference_type`, `reference_id`) by design (§15.4).

## 8. Reviews, notifications, support, platform

```mermaid
erDiagram
  orders ||--o{ reviews : ""
  users ||--o{ reviews : "writes"
  reviews ||--o| review_responses : ""
  reviews ||--o{ review_reports : ""
  reviews ||--o{ review_photos : ""
  users ||--o{ notifications : ""
  notification_templates ||--o{ notification_deliveries : ""
  users ||--o{ notification_preferences : ""
  users ||--o{ support_tickets : "raises"
  orders |o--o{ support_tickets : ""
  support_tickets ||--o{ support_ticket_messages : ""
  support_ticket_messages ||--o{ support_ticket_attachments : ""
  files ||--o{ support_ticket_attachments : ""
  support_tickets |o--o{ complaints : ""
  orders |o--o{ disputes : ""
  users ||--o{ audit_logs : "acts"
```

Platform tables without relationships worth drawing: `platform_settings`, `platform_setting_history`, `feature_flags`, `approval_requests`, `ops_alerts`, `report_exports`, `outbox_events`, `idempotency_keys`, `geocode_cache`, analytics aggregates.
