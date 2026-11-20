-- Further immutability rules from SRS §15.6 (see docs/database/SCHEMA-NOTES.md).

-- Effective-dated configuration is never edited in place (FR-CFG-002): a change
-- is a new row with a later effective_from, so priced orders keep their version.
CREATE TRIGGER fee_schedules_append_only BEFORE UPDATE OR DELETE ON fee_schedules
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER delivery_fee_slabs_append_only BEFORE UPDATE OR DELETE ON delivery_fee_slabs
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER tax_rules_append_only BEFORE UPDATE OR DELETE ON tax_rules
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER commission_plans_append_only BEFORE UPDATE OR DELETE ON commission_plans
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER restaurant_commission_overrides_append_only BEFORE UPDATE OR DELETE ON restaurant_commission_overrides
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();
CREATE TRIGGER partner_pay_plans_append_only BEFORE UPDATE OR DELETE ON partner_pay_plans
  FOR EACH ROW EXECUTE FUNCTION fos_reject_mutation();

-- Dispatch offers: only OFFERED → (ACCEPTED|REJECTED|EXPIRED|WITHDRAWN) and
-- ACCEPTED → (RELEASED|REVOKED) may change, plus displayed_at while OFFERED.
-- Terminal offers are frozen history (FR-DISP-013).
CREATE OR REPLACE FUNCTION fos_delivery_assignments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delivery_assignments rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status NOT IN ('OFFERED', 'ACCEPTED') THEN
    RAISE EXCEPTION 'delivery assignment % is final (%)', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'ACCEPTED' AND NEW.status NOT IN ('ACCEPTED', 'RELEASED', 'REVOKED') THEN
    RAISE EXCEPTION 'accepted assignment can only be released or revoked' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.delivery_id, NEW.partner_id, NEW.round, NEW.rank, NEW.score, NEW.score_breakdown, NEW.offered_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.delivery_id, OLD.partner_id, OLD.round, OLD.rank, OLD.score, OLD.score_breakdown, OLD.offered_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'offer facts are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_assignments_guard BEFORE UPDATE OR DELETE ON delivery_assignments
  FOR EACH ROW EXECUTE FUNCTION fos_delivery_assignments_guard();

-- Webhook events: processing fields change, the received payload never does (FR-PAY-004).
CREATE OR REPLACE FUNCTION fos_webhook_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('fos.allow_redaction', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'payment_webhook_events rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.provider, NEW.event_id, NEW.event_type, NEW.signature_valid, NEW.payload, NEW.received_at)
     IS DISTINCT FROM (OLD.provider, OLD.event_id, OLD.event_type, OLD.signature_valid, OLD.payload, OLD.received_at) THEN
    RAISE EXCEPTION 'webhook event payload is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER payment_webhook_events_guard BEFORE UPDATE OR DELETE ON payment_webhook_events
  FOR EACH ROW EXECUTE FUNCTION fos_webhook_events_guard();

-- Location trail points are never edited; rows are removed only by the 90-day
-- retention job (SRS §20), so DELETE stays allowed.
CREATE OR REPLACE FUNCTION fos_reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'UPDATE on % is not allowed', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER delivery_locations_no_update BEFORE UPDATE ON delivery_locations
  FOR EACH ROW EXECUTE FUNCTION fos_reject_update();
