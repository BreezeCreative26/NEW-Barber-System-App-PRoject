-- Waiting list: offers and the notifications outbox. See docs/WAITLIST-PLAN.md.
-- SQLite cannot widen a CHECK in place; rebuild waitlist_entries with the new statuses + offer fields.
CREATE TABLE waitlist_entries_v2 (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT,
  service_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  daypart TEXT NOT NULL DEFAULT 'ANY' CHECK(daypart IN ('ANY','MORNING','AFTERNOON','EVENING')),
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','OFFERED','BOOKED','CLOSED','EXPIRED')),
  booking_id TEXT,
  offer_id TEXT,
  offers_made INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(shop_id,date,phone,service_id),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
INSERT INTO waitlist_entries_v2(id,shop_id,staff_id,service_id,customer_name,phone,email,date,daypart,notes,status,booking_id,version,created_at,updated_at)
SELECT id,shop_id,staff_id,service_id,customer_name,phone,email,date,daypart,notes,status,booking_id,version,created_at,updated_at FROM waitlist_entries;
DROP TABLE waitlist_entries;
ALTER TABLE waitlist_entries_v2 RENAME TO waitlist_entries;
CREATE INDEX waitlist_shop_date ON waitlist_entries(shop_id,status,date);

-- One row per offer made to a waiting customer. token_hash is the accept/decline capability.
CREATE TABLE waitlist_offers (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  entry_id TEXT NOT NULL REFERENCES waitlist_entries(id),
  staff_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED','SUPERSEDED','LOST')),
  source TEXT NOT NULL CHECK(source IN ('MANUAL','AUTO')),
  booking_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);
CREATE INDEX waitlist_offers_entry ON waitlist_offers(shop_id,entry_id,status);
CREATE INDEX waitlist_offers_slot ON waitlist_offers(shop_id,staff_id,date,start_min,status);

-- Outbox: every message the system intends to send. Nothing leaves the sandbox; rows are SKIPPED
-- until a provider is configured. Append-only except for status/sent_at.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  channel TEXT NOT NULL CHECK(channel IN ('SMS','EMAIL')),
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','SENT','FAILED','SKIPPED')),
  status_note TEXT NOT NULL DEFAULT '',
  related_type TEXT NOT NULL DEFAULT '',
  related_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX notifications_shop ON notifications(shop_id,created_at);
CREATE TRIGGER notifications_immutable_body BEFORE UPDATE OF body,recipient,template,channel,related_type,related_id,created_at ON notifications
BEGIN SELECT RAISE(ABORT,'notification_immutable'); END;
CREATE TRIGGER notifications_no_delete BEFORE DELETE ON notifications
BEGIN SELECT RAISE(ABORT,'notification_immutable'); END;

-- Shop settings for the queue.
ALTER TABLE shops ADD COLUMN waitlist_auto_offer INTEGER NOT NULL DEFAULT 1 CHECK(waitlist_auto_offer IN (0,1));
ALTER TABLE shops ADD COLUMN waitlist_offer_hold_min INTEGER NOT NULL DEFAULT 120 CHECK(waitlist_offer_hold_min BETWEEN 15 AND 1440);
ALTER TABLE shops ADD COLUMN waitlist_templates_json TEXT NOT NULL DEFAULT '{}';
