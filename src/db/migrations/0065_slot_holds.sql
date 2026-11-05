-- Online slot holds: a time a customer has picked is kept for them while they finish booking, so
-- nobody else can take it. Held for up to 5 minutes (expires_at), and only while the page keeps
-- checking in: if they leave, it is released 2 minutes after the last check-in (seen_at).
-- The shop sees it on the timetable as "Booking in progress" and may book over it (released='taken').
CREATE TABLE IF NOT EXISTS slot_holds (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  account_id TEXT,
  holder_hash TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1425),
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  left_at BIGINT,
  released TEXT CHECK (released IS NULL OR released IN ('booked','taken','released')),
  CHECK (end_at > start_at),
  FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id)
);
CREATE INDEX IF NOT EXISTS slot_holds_live ON slot_holds(shop_id, expires_at);
CREATE INDEX IF NOT EXISTS slot_holds_staff ON slot_holds(shop_id, staff_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS slot_holds_holder ON slot_holds(shop_id, holder_hash);
