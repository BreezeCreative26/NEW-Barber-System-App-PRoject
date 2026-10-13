-- Preserve existing test bookings; version columns are nullable for legacy rows only.
ALTER TABLE bookings ADD COLUMN quoted_service_version INTEGER;
ALTER TABLE bookings ADD COLUMN quoted_shop_version INTEGER;

-- The version accepted on the review screen must still match inside the write.
CREATE TRIGGER validate_booking_quote BEFORE INSERT ON bookings
BEGIN
  SELECT RAISE(ABORT,'quote_changed') WHERE NOT EXISTS (
    SELECT 1 FROM services WHERE id=NEW.service_id AND shop_id=NEW.shop_id
    AND version=NEW.quoted_service_version
  );
  SELECT RAISE(ABORT,'quote_changed') WHERE NOT EXISTS (
    SELECT 1 FROM shops WHERE id=NEW.shop_id AND version=NEW.quoted_shop_version
    AND MIN(deposit_pence,NEW.price_pence)=NEW.deposit_policy_pence
    AND cancel_hours=NEW.cancel_hours_snapshot
  );
END;

CREATE TRIGGER immutable_booking_snapshots
BEFORE UPDATE OF id,shop_id,sequence,request_id,request_hash,service_id,service_name,price_pence,duration_min,buffer_min,deposit_policy_pence,cancel_hours_snapshot,source,created_at,quoted_service_version,quoted_shop_version ON bookings
BEGIN
  SELECT RAISE(ABORT,'booking_snapshot_immutable');
END;
