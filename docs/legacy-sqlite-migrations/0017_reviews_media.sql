-- Shop page phase 2: verified reviews and uploaded photos. See docs/SHOP-PAGE-PLAN.md.

-- One review per completed booking, written by the person who had the visit.
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  customer_id TEXT,
  staff_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK(status IN ('PUBLISHED','HIDDEN')),
  reply TEXT NOT NULL DEFAULT '',
  reply_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX reviews_shop_status ON reviews(shop_id,status,created_at);
CREATE INDEX reviews_staff ON reviews(shop_id,staff_id);
-- Once left, the verdict is the customer's: staff can hide or reply, never edit the words.
CREATE TRIGGER reviews_immutable_verdict BEFORE UPDATE OF rating,body,booking_id,customer_id,staff_id,display_name,created_at ON reviews
BEGIN SELECT RAISE(ABORT,'review_immutable'); END;

-- Uploaded images (R2 objects) owned by a shop. Served at /media/<id>.
CREATE TABLE shop_media (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  kind TEXT NOT NULL CHECK(kind IN ('cover','gallery','staff')),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  alt TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX shop_media_shop ON shop_media(shop_id,created_at);
