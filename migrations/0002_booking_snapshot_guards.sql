-- Catalogue edits and rescheduling must never rewrite historical commercial terms.
CREATE TRIGGER protect_booking_snapshots BEFORE UPDATE OF
  shop_id,sequence,request_id,request_hash,service_id,service_name,price_pence,
  duration_min,buffer_min,deposit_policy_pence,cancel_hours_snapshot,source,created_at
ON bookings
WHEN NEW.shop_id<>OLD.shop_id OR NEW.sequence<>OLD.sequence
  OR NEW.request_id<>OLD.request_id OR NEW.request_hash<>OLD.request_hash
  OR NEW.service_id<>OLD.service_id OR NEW.service_name<>OLD.service_name
  OR NEW.price_pence<>OLD.price_pence OR NEW.duration_min<>OLD.duration_min
  OR NEW.buffer_min<>OLD.buffer_min OR NEW.deposit_policy_pence<>OLD.deposit_policy_pence
  OR NEW.cancel_hours_snapshot<>OLD.cancel_hours_snapshot OR NEW.source<>OLD.source
  OR NEW.created_at<>OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'booking_snapshot_immutable');
END;
