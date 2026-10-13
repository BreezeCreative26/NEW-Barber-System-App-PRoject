-- Public online booking, customer self-service links and booking channel.
-- Existing rows keep owner-only behaviour: online booking stays off until enabled.
ALTER TABLE shops ADD COLUMN slug TEXT;
ALTER TABLE shops ADD COLUMN online_booking INTEGER NOT NULL DEFAULT 0 CHECK(online_booking IN (0,1));
ALTER TABLE shops ADD COLUMN lead_time_min INTEGER NOT NULL DEFAULT 60 CHECK(lead_time_min BETWEEN 0 AND 10080);
ALTER TABLE shops ADD COLUMN booking_window_days INTEGER NOT NULL DEFAULT 42 CHECK(booking_window_days BETWEEN 1 AND 365);
CREATE UNIQUE INDEX shops_slug ON shops(slug) WHERE slug IS NOT NULL;

-- Channel records who created the visit; source keeps its existing meaning.
ALTER TABLE bookings ADD COLUMN channel TEXT NOT NULL DEFAULT 'OWNER' CHECK(channel IN ('OWNER','ONLINE'));
ALTER TABLE bookings ADD COLUMN email TEXT NOT NULL DEFAULT '';
CREATE INDEX booking_customers ON bookings(shop_id,phone,start_at);
CREATE TRIGGER immutable_booking_channel BEFORE UPDATE OF channel ON bookings
BEGIN SELECT RAISE(ABORT,'booking_snapshot_immutable'); END;

-- Customer manage links: hashed capability tokens kept apart from booking rows.
CREATE TABLE booking_manage_tokens (
  token_hash TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(booking_id),
  FOREIGN KEY(shop_id,booking_id) REFERENCES bookings(shop_id,id)
);
