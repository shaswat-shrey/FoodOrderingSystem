-- Database rules that Prisma's schema language cannot express (DB-TECH-003).
-- Every rule here is listed in docs/database/SCHEMA-NOTES.md with its requirement.
-- Constant used for "no value" inside unique expressions:
--   '00000000-0000-0000-0000-000000000000'::uuid

-- =============================================================================
-- 1. Shared trigger functions
-- =============================================================================

-- Rejects UPDATE/DELETE on append-only tables. A retention/anonymisation job may
-- UPDATE (never DELETE) after `SET LOCAL fos.allow_redaction = 'on'` (SRS §15.8, §20).
CREATE OR REPLACE FUNCTION fos_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('fos.allow_redaction', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- =============================================================================
-- 2. Identity & sessions
-- =============================================================================

ALTER TABLE users
  ADD CONSTRAINT users_contact_present_chk CHECK (email IS NOT NULL OR phone IS NOT NULL),
  ADD CONSTRAINT users_phone_e164_chk CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');
-- BR-AUTH-014: one account per email / phone among non-anonymised users.
CREATE UNIQUE INDEX users_email_active_uq ON users (email) WHERE email IS NOT NULL AND status <> 'ANONYMIZED';
CREATE UNIQUE INDEX users_phone_active_uq ON users (phone) WHERE phone IS NOT NULL AND status <> 'ANONYMIZED';

-- FR-AUTH-022: exactly one ACTIVE refresh token per session.
CREATE UNIQUE INDEX refresh_tokens_one_active_per_session_uq ON refresh_tokens (session_id) WHERE status = 'ACTIVE';

ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_attempts_chk CHECK (attempts >= 0 AND attempts <= max_attempts);

CREATE TRIGGER user_consents_append_only BEFORE UPDATE OR DELETE ON user_consents
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();

-- =============================================================================
-- 3. Customers, addresses, zones, search
-- =============================================================================

ALTER TABLE customer_addresses
  ADD CONSTRAINT customer_addresses_pincode_chk CHECK (pincode ~ '^[1-9][0-9]{5}$');
CREATE UNIQUE INDEX customer_addresses_one_default_uq ON customer_addresses (user_id)
  WHERE is_default AND deleted_at IS NULL;
CREATE UNIQUE INDEX customer_addresses_home_work_uq ON customer_addresses (user_id, label)
  WHERE label IN ('HOME', 'WORK') AND deleted_at IS NULL;
CREATE INDEX customer_addresses_location_gix ON customer_addresses USING gist (location);

CREATE INDEX zones_polygon_gix ON zones USING gist (polygon);
ALTER TABLE zones
  ADD CONSTRAINT zones_radius_chk CHECK (max_delivery_radius_m BETWEEN 500 AND 15000),
  ADD CONSTRAINT zones_surge_chk CHECK (surge_amount >= 0);

-- FR-ADMIN-070: ACTIVE zones must not overlap (touching edges are allowed).
CREATE OR REPLACE FUNCTION fos_zones_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ACTIVE' AND NEW.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM zones z
    WHERE z.id <> NEW.id
      AND z.status = 'ACTIVE'
      AND z.deleted_at IS NULL
      AND ST_Relate(z.polygon::geometry, NEW.polygon::geometry, 'T********')
  ) THEN
    RAISE EXCEPTION 'zone "%" overlaps another active zone', NEW.name USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zones_no_overlap BEFORE INSERT OR UPDATE OF polygon, status, deleted_at ON zones
  FOR EACH ROW EXECUTE FUNCTION fos_zones_no_overlap();

-- =============================================================================
-- 4. Restaurants & branches
-- =============================================================================

-- Search (ADR-009): weighted tsvector maintained by trigger (unaccent is not
-- IMMUTABLE, so a generated column is not possible) + trigram for typo tolerance.
CREATE OR REPLACE FUNCTION fos_restaurants_search_vector() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.brand_name, ''))), 'A') ||
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.description, ''))), 'C');
  RETURN NEW;
END;
$$;
CREATE TRIGGER restaurants_search_vector BEFORE INSERT OR UPDATE OF brand_name, description ON restaurants
  FOR EACH ROW EXECUTE FUNCTION fos_restaurants_search_vector();
CREATE INDEX restaurants_search_vector_gin ON restaurants USING gin (search_vector);
CREATE INDEX restaurants_brand_name_trgm ON restaurants USING gin (brand_name gin_trgm_ops);

ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_gstin_chk CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD CONSTRAINT restaurants_fssai_chk CHECK (fssai_number IS NULL OR fssai_number ~ '^[0-9]{14}$'),
  ADD CONSTRAINT restaurants_rating_chk CHECK (rating_avg_bps IS NULL OR rating_avg_bps BETWEEN 10000 AND 50000);

CREATE UNIQUE INDEX restaurant_bank_accounts_one_verified_uq ON restaurant_bank_accounts (restaurant_id)
  WHERE status = 'VERIFIED';
ALTER TABLE restaurant_bank_accounts ADD CONSTRAINT restaurant_bank_accounts_ifsc_chk CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

CREATE INDEX branches_location_gix ON branches USING gist (location);
ALTER TABLE branches
  ADD CONSTRAINT branches_radius_chk CHECK (delivery_radius_m BETWEEN 500 AND 15000),
  ADD CONSTRAINT branches_prep_chk CHECK (default_prep_minutes BETWEEN 5 AND 90),
  ADD CONSTRAINT branches_rush_chk CHECK (rush_extra_minutes BETWEEN 0 AND 30),
  ADD CONSTRAINT branches_pincode_chk CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  ADD CONSTRAINT branches_min_order_chk CHECK (min_order_amount BETWEEN 0 AND 50000),
  ADD CONSTRAINT branches_max_order_chk CHECK (max_order_amount IS NULL OR max_order_amount > min_order_amount),
  ADD CONSTRAINT branches_packaging_chk CHECK (packaging_fee_amount >= 0);

ALTER TABLE branch_operating_hours
  ADD CONSTRAINT branch_operating_hours_weekday_chk CHECK (weekday BETWEEN 0 AND 6),
  ADD CONSTRAINT branch_operating_hours_nonempty_chk CHECK (opens_at <> closes_at);

-- BR-REST-003: at most 3 slots per branch per weekday.
CREATE OR REPLACE FUNCTION fos_branch_hours_max_slots() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM branch_operating_hours
      WHERE branch_id = NEW.branch_id AND weekday = NEW.weekday AND id <> NEW.id) >= 3 THEN
    RAISE EXCEPTION 'a branch may have at most 3 operating slots per weekday' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER branch_operating_hours_max_slots BEFORE INSERT OR UPDATE OF branch_id, weekday ON branch_operating_hours
  FOR EACH ROW EXECUTE FUNCTION fos_branch_hours_max_slots();

ALTER TABLE branch_holidays ADD CONSTRAINT branch_holidays_range_chk CHECK (ends_at > starts_at);

CREATE TRIGGER branch_status_events_append_only BEFORE UPDATE OR DELETE ON branch_status_events
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER restaurant_application_reviews_append_only BEFORE UPDATE OR DELETE ON restaurant_application_reviews
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();

-- ADR-002: one live membership per user per restaurant; exactly one active owner.
CREATE UNIQUE INDEX restaurant_members_live_uq ON restaurant_members (restaurant_id, user_id) WHERE status <> 'REMOVED';
CREATE UNIQUE INDEX restaurant_members_one_owner_uq ON restaurant_members (restaurant_id)
  WHERE role = 'OWNER' AND status = 'ACTIVE';

ALTER TABLE commission_plans ADD CONSTRAINT commission_plans_rate_chk CHECK (rate_bps BETWEEN 0 AND 10000);
ALTER TABLE restaurant_commission_overrides ADD CONSTRAINT restaurant_commission_overrides_rate_chk CHECK (rate_bps BETWEEN 0 AND 10000);

-- =============================================================================
-- 5. Menu
-- =============================================================================

CREATE UNIQUE INDEX menu_categories_name_uq ON menu_categories (restaurant_id, lower(name)) WHERE deleted_at IS NULL;

-- BR-MENU-002/005: ₹1 – ₹1,00,000; discounted price below base and ≥ ₹1.
ALTER TABLE food_items
  ADD CONSTRAINT food_items_price_chk CHECK (base_price_amount BETWEEN 100 AND 10000000),
  ADD CONSTRAINT food_items_discount_chk CHECK (
    discounted_price_amount IS NULL OR (discounted_price_amount >= 100 AND discounted_price_amount < base_price_amount)),
  ADD CONSTRAINT food_items_spice_chk CHECK (spice_level IS NULL OR spice_level BETWEEN 0 AND 3),
  ADD CONSTRAINT food_items_prep_chk CHECK (prep_minutes IS NULL OR prep_minutes BETWEEN 1 AND 180);

CREATE OR REPLACE FUNCTION fos_food_items_search_vector() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.name, ''))), 'A') ||
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.description, ''))), 'C');
  RETURN NEW;
END;
$$;
CREATE TRIGGER food_items_search_vector BEFORE INSERT OR UPDATE OF name, description ON food_items
  FOR EACH ROW EXECUTE FUNCTION fos_food_items_search_vector();
CREATE INDEX food_items_search_vector_gin ON food_items USING gin (search_vector);
CREATE INDEX food_items_name_trgm ON food_items USING gin (name gin_trgm_ops);

-- BR-MENU-004: one default variant per item.
CREATE UNIQUE INDEX food_item_variants_one_default_uq ON food_item_variants (food_item_id)
  WHERE is_default AND deleted_at IS NULL;
ALTER TABLE food_item_variants ADD CONSTRAINT food_item_variants_price_chk CHECK (price_amount BETWEEN 100 AND 10000000);

-- BR-MENU-003.
ALTER TABLE customization_groups
  ADD CONSTRAINT customization_groups_selection_chk CHECK (min_select >= 0 AND max_select >= 1 AND max_select >= min_select);
ALTER TABLE customization_options ADD CONSTRAINT customization_options_price_chk CHECK (price_delta_amount >= 0);

-- A group is attached at most once per item and variant (NULL variant = all variants).
CREATE UNIQUE INDEX food_item_customization_groups_uq ON food_item_customization_groups
  (food_item_id, group_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE branch_item_stock ADD CONSTRAINT branch_item_stock_quantity_chk CHECK (quantity >= 0);
ALTER TABLE availability_schedules
  ADD CONSTRAINT availability_schedules_weekday_chk CHECK (weekday BETWEEN 0 AND 6),
  ADD CONSTRAINT availability_schedules_range_chk CHECK (ends_at > starts_at);
ALTER TABLE combo_components
  ADD CONSTRAINT combo_components_quantity_chk CHECK (quantity BETWEEN 1 AND 20),
  ADD CONSTRAINT combo_components_not_self_chk CHECK (combo_item_id <> component_item_id);

-- =============================================================================
-- 6. Cart, checkout, pricing config, coupons, promotions
-- =============================================================================

-- BR-CART-001: one ACTIVE cart per user.
CREATE UNIQUE INDEX carts_one_active_per_user_uq ON carts (user_id) WHERE status = 'ACTIVE';
ALTER TABLE cart_items ADD CONSTRAINT cart_items_quantity_chk CHECK (quantity BETWEEN 1 AND 20);

ALTER TABLE checkout_sessions
  ADD CONSTRAINT checkout_sessions_tip_chk CHECK (tip_amount BETWEEN 0 AND 50000 AND tip_amount % 100 = 0),
  ADD CONSTRAINT checkout_sessions_payable_chk CHECK (payable_amount >= 0);

ALTER TABLE fee_schedules ADD CONSTRAINT fee_schedules_non_negative_chk CHECK (
  platform_fee_amount >= 0 AND small_order_threshold_amount >= 0 AND small_order_fee_amount >= 0
  AND per_km_beyond_slabs_amount >= 0 AND packaging_cap_per_item_amount >= 0
  AND packaging_cap_per_order_amount >= 0 AND surge_cap_amount >= 0);
ALTER TABLE delivery_fee_slabs
  ADD CONSTRAINT delivery_fee_slabs_range_chk CHECK (from_m >= 0 AND to_m > from_m),
  ADD CONSTRAINT delivery_fee_slabs_fee_chk CHECK (fee_amount >= 0);
ALTER TABLE tax_rules ADD CONSTRAINT tax_rules_rate_chk CHECK (rate_bps BETWEEN 0 AND 10000);

CREATE UNIQUE INDEX coupons_code_live_uq ON coupons (code) WHERE deleted_at IS NULL;
ALTER TABLE coupons
  ADD CONSTRAINT coupons_window_chk CHECK (ends_at > starts_at),
  ADD CONSTRAINT coupons_value_chk CHECK (value >= 0),
  -- BR-COUPON-004: percentage coupons need a cap and at most 100 %.
  ADD CONSTRAINT coupons_percent_chk CHECK (
    discount_type <> 'PERCENT' OR (value BETWEEN 1 AND 10000 AND max_discount_amount IS NOT NULL)),
  ADD CONSTRAINT coupons_counts_chk CHECK (used_count >= 0 AND reserved_count >= 0),
  -- BR-COUPON-003: reserved + redeemed never exceed the global limit.
  ADD CONSTRAINT coupons_limit_chk CHECK (usage_limit_total IS NULL OR used_count + reserved_count <= usage_limit_total),
  ADD CONSTRAINT coupons_per_user_chk CHECK (usage_limit_per_user >= 1),
  ADD CONSTRAINT coupons_share_chk CHECK (restaurant_share_bps BETWEEN 0 AND 10000);
ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_discount_chk CHECK (discount_amount >= 0);

ALTER TABLE promotions
  ADD CONSTRAINT promotions_window_chk CHECK (ends_at > starts_at),
  ADD CONSTRAINT promotions_scope_chk CHECK ((scope = 'RESTAURANT') = (restaurant_id IS NOT NULL)),
  ADD CONSTRAINT promotions_percent_chk CHECK (type <> 'PERCENT_OFF' OR value BETWEEN 1 AND 10000);
ALTER TABLE banners ADD CONSTRAINT banners_window_chk CHECK (ends_at > starts_at);

-- =============================================================================
-- 7. Orders (snapshots are append-only, SRS §15.6)
-- =============================================================================

ALTER TABLE orders
  ADD CONSTRAINT orders_amounts_chk CHECK (
    items_subtotal_amount >= 0 AND discount_total_amount >= 0 AND fees_total_amount >= 0
    AND tax_total_amount >= 0 AND wallet_applied_amount >= 0 AND total_amount >= 0),
  ADD CONSTRAINT orders_tip_chk CHECK (tip_amount BETWEEN 0 AND 50000),
  ADD CONSTRAINT orders_payable_chk CHECK (payable_amount = total_amount - wallet_applied_amount),
  ADD CONSTRAINT orders_commission_chk CHECK (commission_rate_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT orders_failure_reason_chk CHECK ((status = 'FAILED') = (failure_reason IS NOT NULL));
-- Active-order dashboards and sweeper (JOB-ORD-007).
CREATE INDEX orders_active_idx ON orders (status, updated_at)
  WHERE status IN ('PAYMENT_PENDING', 'PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP');

ALTER TABLE order_items
  ADD CONSTRAINT order_items_quantity_chk CHECK (quantity BETWEEN 1 AND 20),
  ADD CONSTRAINT order_items_amounts_chk CHECK (
    unit_price_amount >= 0 AND options_amount >= 0 AND item_discount_amount >= 0 AND line_total_amount >= 0);
ALTER TABLE order_cancellations ADD CONSTRAINT order_cancellations_amounts_chk CHECK (fee_amount >= 0 AND refund_amount >= 0);

CREATE TRIGGER order_addresses_append_only BEFORE UPDATE OR DELETE ON order_addresses
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER order_items_append_only BEFORE UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER order_item_options_append_only BEFORE UPDATE OR DELETE ON order_item_options
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER order_price_components_append_only BEFORE UPDATE OR DELETE ON order_price_components
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER order_status_history_append_only BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER order_cancellations_append_only BEFORE UPDATE OR DELETE ON order_cancellations
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER invoices_append_only BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();

-- =============================================================================
-- 8. Payments, refunds, ledger, payouts
-- =============================================================================

CREATE UNIQUE INDEX payments_provider_order_uq ON payments (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
ALTER TABLE payments
  ADD CONSTRAINT payments_amount_chk CHECK (amount >= 0),
  -- FR-REFUND-003 / FR-PAY-008.
  ADD CONSTRAINT payments_refund_bound_chk CHECK (refunded_amount >= 0 AND refunded_amount <= captured_amount),
  ADD CONSTRAINT payments_capture_bound_chk CHECK (captured_amount >= 0 AND captured_amount <= amount);
ALTER TABLE refunds ADD CONSTRAINT refunds_amount_chk CHECK (amount > 0);
ALTER TABLE refund_items ADD CONSTRAINT refund_items_chk CHECK (quantity >= 1 AND amount >= 0);

-- One account per owner, type and currency (NULL owner = platform-level account).
CREATE UNIQUE INDEX ledger_accounts_owner_type_uq ON ledger_accounts
  (owner_type, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), type, currency);
-- FR-PAY-012 / DB-INT-004: wallets never go negative.
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_wallet_non_negative_chk CHECK (
  type NOT IN ('CUSTOMER_WALLET', 'CUSTOMER_WALLET_HOLD', 'PARTNER_CASH_IN_HAND') OR balance >= 0);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_nonzero_chk CHECK (amount <> 0);

-- DB-INT-004: every journal transaction balances to zero. Deferred to commit so
-- all entries of a transaction can be inserted first.
CREATE OR REPLACE FUNCTION fos_ledger_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
  entry_count int;
BEGIN
  SELECT coalesce(sum(amount), 0), count(*) INTO total, entry_count
  FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF entry_count < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (entries=%, sum=%)', NEW.transaction_id, entry_count, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fos_ledger_transaction_balanced();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();

ALTER TABLE wallet_credit_lots ADD CONSTRAINT wallet_credit_lots_amounts_chk CHECK (amount > 0 AND remaining BETWEEN 0 AND amount);

ALTER TABLE payouts
  ADD CONSTRAINT payouts_amount_chk CHECK (amount > 0),
  ADD CONSTRAINT payouts_single_payee_chk CHECK (
    (payee_type = 'RESTAURANT' AND restaurant_id IS NOT NULL AND partner_id IS NULL AND partner_bank_account_id IS NULL)
    OR (payee_type = 'PARTNER' AND partner_id IS NOT NULL AND restaurant_id IS NULL AND restaurant_bank_account_id IS NULL));
CREATE UNIQUE INDEX payouts_one_per_payee_per_batch_uq ON payouts (batch_id, payee_type, coalesce(restaurant_id, partner_id));
ALTER TABLE restaurant_settlements ADD CONSTRAINT restaurant_settlements_period_chk CHECK (period_end > period_start);
ALTER TABLE payout_batches ADD CONSTRAINT payout_batches_period_chk CHECK (period_end > period_start);

-- =============================================================================
-- 9. Delivery partners, deliveries, dispatch
-- =============================================================================

CREATE INDEX delivery_partners_last_location_gix ON delivery_partners USING gist (last_location);
ALTER TABLE delivery_partners ADD CONSTRAINT delivery_partners_aadhaar_last4_chk CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$');

CREATE UNIQUE INDEX partner_vehicles_one_active_uq ON partner_vehicles (partner_id) WHERE is_active AND deleted_at IS NULL;
CREATE UNIQUE INDEX partner_vehicles_registration_verified_uq ON partner_vehicles (registration_number)
  WHERE status = 'VERIFIED' AND deleted_at IS NULL AND registration_number IS NOT NULL;
CREATE UNIQUE INDEX partner_bank_accounts_one_verified_uq ON partner_bank_accounts (partner_id) WHERE status = 'VERIFIED';
ALTER TABLE partner_bank_accounts ADD CONSTRAINT partner_bank_accounts_ifsc_chk CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

-- BR-DEL-014 / FR-DISP-007: at most one active delivery per partner (MVP).
CREATE UNIQUE INDEX deliveries_one_active_per_partner_uq ON deliveries (partner_id)
  WHERE status IN ('ASSIGNED', 'AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER');
ALTER TABLE deliveries ADD CONSTRAINT deliveries_assigned_has_partner_chk CHECK (
  status IN ('PENDING', 'SEARCHING', 'CANCELLED') OR partner_id IS NOT NULL);

-- FR-DISP-006/007: exactly-once assignment; one open offer per partner.
CREATE UNIQUE INDEX delivery_assignments_one_accepted_uq ON delivery_assignments (delivery_id) WHERE status = 'ACCEPTED';
CREATE UNIQUE INDEX delivery_assignments_one_offer_per_partner_uq ON delivery_assignments (partner_id) WHERE status = 'OFFERED';
ALTER TABLE delivery_assignments ADD CONSTRAINT delivery_assignments_expiry_chk CHECK (expires_at > offered_at);

CREATE TRIGGER delivery_status_history_append_only BEFORE UPDATE OR DELETE ON delivery_status_history
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER partner_earnings_append_only BEFORE UPDATE OR DELETE ON partner_earnings
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
ALTER TABLE partner_earnings ADD CONSTRAINT partner_earnings_amounts_chk CHECK (
  base_amount >= 0 AND distance_amount >= 0 AND wait_amount >= 0 AND surge_amount >= 0 AND tip_amount >= 0
  AND total_amount = base_amount + distance_amount + wait_amount + surge_amount + tip_amount);
ALTER TABLE delivery_locations ADD CONSTRAINT delivery_locations_accuracy_chk CHECK (accuracy_m >= 0);

-- =============================================================================
-- 10. Reviews, notifications, support, platform
-- =============================================================================

ALTER TABLE reviews
  ADD CONSTRAINT reviews_rating_chk CHECK (rating BETWEEN 1 AND 5),
  ADD CONSTRAINT reviews_target_chk CHECK (
    (target_type = 'RESTAURANT' AND restaurant_id IS NOT NULL AND branch_id IS NOT NULL AND partner_id IS NULL AND food_item_id IS NULL)
    OR (target_type = 'PARTNER' AND partner_id IS NOT NULL AND food_item_id IS NULL)
    OR (target_type = 'ITEM' AND food_item_id IS NOT NULL AND partner_id IS NULL));
-- BR-REVIEW-002: one review per order per target.
CREATE UNIQUE INDEX reviews_one_per_target_uq ON reviews
  (order_id, target_type, coalesce(food_item_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL AND deleted_at IS NULL;

ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_csat_chk CHECK (csat IS NULL OR csat BETWEEN 1 AND 5);

-- BR-ADMIN-001: maker ≠ checker.
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_maker_checker_chk CHECK (decided_by IS NULL OR decided_by <> requested_by);

CREATE UNIQUE INDEX ops_alerts_open_dedupe_uq ON ops_alerts (dedupe_key) WHERE status = 'OPEN';

ALTER TABLE files ADD CONSTRAINT files_size_chk CHECK (size_bytes > 0 AND size_bytes <= 26214400);

-- FR-AUDIT-002: audit log is append-only (no redaction exemption for DELETE).
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();

-- Outbox relay scan (ADR-010).
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (sequence) WHERE published_at IS NULL;
