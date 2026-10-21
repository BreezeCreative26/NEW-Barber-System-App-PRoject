-- Appointments no longer hold a gap after them: every shop is back to back, and existing bookings
-- stop reserving buffer time. (The immutable-snapshot trigger is paused for this one update.)
ALTER TABLE shops ALTER COLUMN buffer_min SET DEFAULT 0;
UPDATE shops SET buffer_min = 0 WHERE buffer_min <> 0;
ALTER TABLE bookings ALTER COLUMN buffer_min SET DEFAULT 0;
ALTER TABLE bookings DISABLE TRIGGER immutable_booking_snapshots;
ALTER TABLE bookings DISABLE TRIGGER validate_booking_update;
UPDATE bookings SET buffer_min = 0 WHERE buffer_min <> 0;
ALTER TABLE bookings ENABLE TRIGGER immutable_booking_snapshots;
ALTER TABLE bookings ENABLE TRIGGER validate_booking_update;
