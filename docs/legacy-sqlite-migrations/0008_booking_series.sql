-- Standing (recurring) bookings: a series groups independently guarded visits.
ALTER TABLE bookings ADD COLUMN series_id TEXT;
CREATE INDEX booking_series_lookup ON bookings(shop_id,series_id);
CREATE TRIGGER immutable_booking_series BEFORE UPDATE OF series_id ON bookings
BEGIN SELECT RAISE(ABORT,'booking_snapshot_immutable'); END;
CREATE TABLE booking_series (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  interval_weeks INTEGER NOT NULL CHECK(interval_weeks BETWEEN 1 AND 12),
  start_date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  occurrences INTEGER NOT NULL CHECK(occurrences BETWEEN 2 AND 26),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
