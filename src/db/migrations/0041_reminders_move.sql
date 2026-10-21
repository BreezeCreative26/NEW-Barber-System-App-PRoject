-- A moved booking must get a fresh reminder. The message log is append-only, so reminder
-- de-duplication moves to a small table keyed on the booking AND its start time: a new start
-- time is a new key. Reminders that were queued for the old time are cancelled.
CREATE TABLE IF NOT EXISTS reminder_marks (
  shop_id TEXT NOT NULL REFERENCES shops(id), booking_id TEXT NOT NULL, template TEXT NOT NULL, start_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, booking_id, template, start_at)
);
-- Bookings already reminded must not be reminded again at their current time.
INSERT INTO reminder_marks(shop_id, booking_id, template, start_at, created_at)
  SELECT DISTINCT n.shop_id, n.related_id, n.template, b.start_at, n.created_at
  FROM notifications n JOIN bookings b ON b.shop_id=n.shop_id AND b.id=n.related_id
  WHERE n.template IN ('booking_reminder','booking_reminder_soon')
ON CONFLICT DO NOTHING;
DROP INDEX IF EXISTS notifications_once_per_booking;
CREATE UNIQUE INDEX notifications_once_per_booking ON notifications(shop_id, related_id, template, channel) WHERE template IN ('booking_confirmed');
CREATE OR REPLACE FUNCTION skip_reminders_on_move() RETURNS trigger AS $$
BEGIN
  IF NEW.start_at IS DISTINCT FROM OLD.start_at THEN
    UPDATE notifications SET status='SKIPPED', status_note='Booking was moved before this was sent.'
     WHERE shop_id=OLD.shop_id AND related_id=OLD.id AND status='QUEUED' AND attempts=0
       AND template IN ('booking_reminder','booking_reminder_soon');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS bookings_skip_reminders ON bookings;
CREATE TRIGGER bookings_skip_reminders AFTER UPDATE OF start_at ON bookings
  FOR EACH ROW EXECUTE FUNCTION skip_reminders_on_move();
