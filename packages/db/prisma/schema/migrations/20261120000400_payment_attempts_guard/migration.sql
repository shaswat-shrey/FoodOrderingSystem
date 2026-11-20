-- SRS v0.3.0 (D-1): a payment attempt's status progresses (CREATED → AUTHORIZED →
-- CAPTURED/FAILED) but the facts identifying it never change, and attempts are
-- never deleted.
CREATE OR REPLACE FUNCTION fos_payment_attempts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_attempts rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.payment_id, NEW.amount, NEW.created_at) IS DISTINCT FROM (OLD.payment_id, OLD.amount, OLD.created_at)
     OR (OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id) THEN
    RAISE EXCEPTION 'payment attempt facts are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_attempts_guard BEFORE UPDATE OR DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION fos_payment_attempts_guard();
