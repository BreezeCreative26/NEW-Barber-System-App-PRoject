PRAGMA foreign_keys = ON;

CREATE TABLE shops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  opens INTEGER NOT NULL DEFAULT 540 CHECK(opens BETWEEN 0 AND 1439),
  closes INTEGER NOT NULL DEFAULT 1080 CHECK(closes BETWEEN 1 AND 1440 AND closes > opens),
  closed_days TEXT NOT NULL DEFAULT '[0]',
  deposit_pence INTEGER NOT NULL DEFAULT 500 CHECK(deposit_pence >= 0),
  cancel_hours INTEGER NOT NULL DEFAULT 24 CHECK(cancel_hours BETWEEN 0 AND 168),
  no_show_grace INTEGER NOT NULL DEFAULT 15 CHECK(no_show_grace BETWEEN 0 AND 120),
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE sandbox_sessions (
  token_hash TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_shop ON sandbox_sessions(shop_id);
CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Barber',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(shop_id,id)
);
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Hair',
  duration_min INTEGER NOT NULL CHECK(duration_min BETWEEN 5 AND 240),
  price_pence INTEGER NOT NULL CHECK(price_pence BETWEEN 0 AND 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(shop_id,id)
);
CREATE TABLE staff_hours (
  shop_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  starts INTEGER NOT NULL CHECK(starts BETWEEN 0 AND 1439),
  ends INTEGER NOT NULL CHECK(ends BETWEEN 1 AND 1440 AND ends > starts),
  break_start INTEGER NOT NULL CHECK(break_start >= starts),
  break_end INTEGER NOT NULL CHECK(break_end >= break_start AND break_end <= ends),
  PRIMARY KEY(shop_id,staff_id,weekday),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE TABLE holidays (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  date TEXT NOT NULL,
  label TEXT NOT NULL,
  UNIQUE(shop_id,date)
);
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  sequence INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK(end_at > start_at),
  duration_min INTEGER NOT NULL,
  buffer_min INTEGER NOT NULL DEFAULT 10 CHECK(buffer_min = 10),
  service_name TEXT NOT NULL,
  price_pence INTEGER NOT NULL CHECK(price_pence >= 0),
  deposit_policy_pence INTEGER NOT NULL CHECK(deposit_policy_pence >= 0),
  cancel_hours_snapshot INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('TEST_BOOKING','WALK_IN')),
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED','CANCELLED','NO_SHOW')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(shop_id,id),
  UNIQUE(shop_id,sequence),
  UNIQUE(shop_id,request_id),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
CREATE INDEX booking_intervals ON bookings(shop_id,staff_id,start_at,end_at,status);
CREATE INDEX booking_days ON bookings(shop_id,date);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_shop_time ON audit_events(shop_id,created_at);

-- These triggers execute inside the same SQLite write transaction as the mutation.
-- An application-level SELECT alone is NOT the booking lock.
CREATE TRIGGER prevent_booking_overlap_insert BEFORE INSERT ON bookings
WHEN NEW.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')
BEGIN
  SELECT RAISE(ABORT,'slot_taken') WHERE EXISTS (
    SELECT 1 FROM bookings b WHERE b.shop_id=NEW.shop_id AND b.staff_id=NEW.staff_id
    AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')
    AND b.start_at < NEW.end_at + NEW.buffer_min * 60000
    AND NEW.start_at < b.end_at + b.buffer_min * 60000
  );
END;
CREATE TRIGGER prevent_booking_overlap_update BEFORE UPDATE OF staff_id,start_at,end_at,status ON bookings
WHEN NEW.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')
BEGIN
  SELECT RAISE(ABORT,'slot_taken') WHERE EXISTS (
    SELECT 1 FROM bookings b WHERE b.shop_id=NEW.shop_id AND b.staff_id=NEW.staff_id AND b.id<>NEW.id
    AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')
    AND b.start_at < NEW.end_at + NEW.buffer_min * 60000
    AND NEW.start_at < b.end_at + b.buffer_min * 60000
  );
END;
-- Snapshot and schedule source state must still match at the point of insertion.
CREATE TRIGGER validate_booking_insert BEFORE INSERT ON bookings
BEGIN
  SELECT RAISE(ABORT,'barber_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM staff WHERE id=NEW.staff_id AND shop_id=NEW.shop_id AND active=1
  );
  SELECT RAISE(ABORT,'service_changed') WHERE NOT EXISTS (
    SELECT 1 FROM services WHERE id=NEW.service_id AND shop_id=NEW.shop_id AND active=1
    AND duration_min=NEW.duration_min AND price_pence=NEW.price_pence AND name=NEW.service_name
  );
  SELECT RAISE(ABORT,'shop_closed') WHERE EXISTS (
    SELECT 1 FROM holidays WHERE shop_id=NEW.shop_id AND date=NEW.date
  );
  SELECT RAISE(ABORT,'outside_hours') WHERE NOT EXISTS (
    SELECT 1 FROM staff_hours h JOIN shops s ON s.id=h.shop_id
    WHERE h.shop_id=NEW.shop_id AND h.staff_id=NEW.staff_id
    AND h.weekday=CAST(strftime('%w',NEW.date) AS INTEGER) AND h.enabled=1
    AND NEW.start_min>=MAX(h.starts,s.opens)
    AND NEW.start_min+NEW.duration_min+NEW.buffer_min<=MIN(h.ends,s.closes)
    AND NOT (h.break_end>h.break_start AND NEW.start_min<h.break_end AND NEW.start_min+NEW.duration_min+NEW.buffer_min>h.break_start)
    AND NOT EXISTS(SELECT 1 FROM json_each(s.closed_days) d WHERE d.value=h.weekday)
  );
END;
CREATE TRIGGER validate_booking_reschedule BEFORE UPDATE OF staff_id,start_at,end_at ON bookings
BEGIN
  SELECT RAISE(ABORT,'barber_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM staff WHERE id=NEW.staff_id AND shop_id=NEW.shop_id AND active=1
  );
  SELECT RAISE(ABORT,'shop_closed') WHERE EXISTS (
    SELECT 1 FROM holidays WHERE shop_id=NEW.shop_id AND date=NEW.date
  );
  SELECT RAISE(ABORT,'outside_hours') WHERE NOT EXISTS (
    SELECT 1 FROM staff_hours h JOIN shops s ON s.id=h.shop_id
    WHERE h.shop_id=NEW.shop_id AND h.staff_id=NEW.staff_id
    AND h.weekday=CAST(strftime('%w',NEW.date) AS INTEGER) AND h.enabled=1
    AND NEW.start_min>=MAX(h.starts,s.opens)
    AND NEW.start_min+NEW.duration_min+NEW.buffer_min<=MIN(h.ends,s.closes)
    AND NOT (h.break_end>h.break_start AND NEW.start_min<h.break_end AND NEW.start_min+NEW.duration_min+NEW.buffer_min>h.break_start)
    AND NOT EXISTS(SELECT 1 FROM json_each(s.closed_days) d WHERE d.value=h.weekday)
  );
END;
CREATE TRIGGER prevent_booking_delete BEFORE DELETE ON bookings BEGIN SELECT RAISE(ABORT,'booking_delete_forbidden'); END;
CREATE TRIGGER prevent_audit_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_immutable'); END;
CREATE TRIGGER prevent_audit_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_immutable'); END;
