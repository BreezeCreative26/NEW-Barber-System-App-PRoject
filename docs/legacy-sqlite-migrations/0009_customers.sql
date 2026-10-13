-- Customer records: one row per shop + mobile number, linked from every booking.
-- Bookings keep their own name/phone/email snapshot (immutable history); the
-- customer row carries the current, editable profile.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  birthday TEXT,
  preferred_staff_id TEXT,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(marketing_opt_in IN (0,1)),
  merged_into TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(shop_id,id),
  UNIQUE(shop_id,phone),
  FOREIGN KEY(shop_id,preferred_staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX customers_shop_name ON customers(shop_id,name);

ALTER TABLE bookings ADD COLUMN customer_id TEXT;
CREATE INDEX booking_customer ON bookings(shop_id,customer_id,start_at);

-- Backfill: one customer per existing shop/phone, newest name wins.
INSERT INTO customers(id,shop_id,name,phone,email,created_at,updated_at)
SELECT lower(hex(randomblob(16))), shop_id, customer_name, phone, COALESCE(email,''), MIN(created_at), MAX(updated_at)
FROM (
  SELECT b.shop_id, b.phone, b.customer_name, b.email, b.created_at, b.updated_at
  FROM bookings b
  WHERE b.created_at = (SELECT MAX(x.created_at) FROM bookings x WHERE x.shop_id=b.shop_id AND x.phone=b.phone)
) latest
GROUP BY shop_id, phone;
UPDATE bookings SET customer_id=(SELECT c.id FROM customers c WHERE c.shop_id=bookings.shop_id AND c.phone=bookings.phone)
WHERE customer_id IS NULL;

-- Every new booking is linked to a customer record automatically (created when missing).
CREATE TRIGGER booking_customer_link AFTER INSERT ON bookings
WHEN NEW.customer_id IS NULL
BEGIN
  INSERT OR IGNORE INTO customers(id,shop_id,name,phone,email,created_at,updated_at)
  VALUES(lower(hex(randomblob(16))), NEW.shop_id, NEW.customer_name, NEW.phone, NEW.email, NEW.created_at, NEW.created_at);
  UPDATE bookings SET customer_id=(SELECT c.id FROM customers c WHERE c.shop_id=NEW.shop_id AND c.phone=NEW.phone)
  WHERE id=NEW.id;
END;
-- A booking created against a chosen customer must belong to the same shop.
CREATE TRIGGER booking_customer_scope BEFORE INSERT ON bookings
WHEN NEW.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=NEW.customer_id AND c.shop_id=NEW.shop_id)
BEGIN SELECT RAISE(ABORT,'customer_scope'); END;
-- Customers are never deleted; merges point the loser at the winner.
CREATE TRIGGER prevent_customer_delete BEFORE DELETE ON customers
BEGIN SELECT RAISE(ABORT,'customer_delete_forbidden'); END;
