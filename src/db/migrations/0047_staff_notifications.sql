-- Team notifications: one row per thing that happened (new booking, customer cancelled, no-show,
-- customer moved a visit). Who sees it is decided when it is read: owners, managers, reception and
-- the shop login see everything; a barber sees their own bookings unless they were granted
-- "all_notifications". Read state is per viewer (a time marker), and each device that turned
-- on push is stored per account.
CREATE TABLE IF NOT EXISTS shop_events (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  booking_id TEXT,
  staff_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_events_shop_time ON shop_events(shop_id, created_at DESC);
CREATE TABLE IF NOT EXISTS shop_event_seen (
  shop_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  seen_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, viewer_id)
);
CREATE TABLE IF NOT EXISTS staff_push_subscriptions (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  UNIQUE (shop_id, endpoint)
);
