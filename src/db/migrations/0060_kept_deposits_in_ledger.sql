-- A deposit the shop keeps (customer cancels inside the policy window, or no-show) is the shop's money:
-- it must reach the ledger so a pay run pays it out. The ledger only accepted payments on a visit that
-- was in service or completed, so a kept deposit could never be recorded and sat with foliyo forever.
-- Allow exactly one extra case: the ONLINE deposit tender on a cancelled / no-show visit whose deposit is PAID.
CREATE OR REPLACE FUNCTION ollo_payments_visit_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b RECORD;
BEGIN
  SELECT status, deposit_status INTO b FROM bookings WHERE shop_id=NEW.shop_id AND id=NEW.booking_id;
  IF b.status IN ('IN_SERVICE','COMPLETED') THEN RETURN NEW; END IF;
  IF NEW.method='ONLINE' AND b.status IN ('CANCELLED','NO_SHOW') AND b.deposit_status='PAID' THEN RETURN NEW; END IF;
  PERFORM ollo_abort('payment_visit_not_in_service');
  RETURN NEW;
END $$;
