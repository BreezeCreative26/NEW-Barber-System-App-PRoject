-- Payments stay immutable, but the settlement link may move.
-- The original trigger refused every UPDATE on a live payment unless it was a void, so claiming a
-- period's payments into a pay run (mark paid / Stripe transfer) or releasing them on void failed
-- with database_error as soon as the period had any payments. Allow exactly one thing to change on
-- a live payment: pay_run_id. Everything else still aborts as before.
CREATE OR REPLACE FUNCTION ollo_payments_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN PERFORM ollo_abort('payment_already_voided'); END IF;
  IF NEW.id<>OLD.id OR NEW.shop_id<>OLD.shop_id OR NEW.booking_id<>OLD.booking_id OR NEW.staff_id<>OLD.staff_id
     OR NEW.method<>OLD.method OR NEW.service_pence<>OLD.service_pence OR NEW.tip_pence<>OLD.tip_pence
     OR NEW.discount_pence<>OLD.discount_pence OR NEW.commission_pct<>OLD.commission_pct OR NEW.created_at<>OLD.created_at THEN
    PERFORM ollo_abort('payment_immutable');
  END IF;
  IF NEW.voided_at IS NULL THEN
    -- Not a void: the only permitted change is the pay-run settlement link.
    IF (to_jsonb(NEW) - 'pay_run_id') <> (to_jsonb(OLD) - 'pay_run_id') THEN
      PERFORM ollo_abort('payment_void_required');
    END IF;
  END IF;
  RETURN NEW;
END $$;
