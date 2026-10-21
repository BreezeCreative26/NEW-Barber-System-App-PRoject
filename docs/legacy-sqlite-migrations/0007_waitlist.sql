-- Customer waitlist for dates with no open time. Owner converts by booking; no automatic messaging.
CREATE TABLE waitlist_entries (
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
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','BOOKED','CLOSED')),
  booking_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(shop_id,date,phone,service_id),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
CREATE INDEX waitlist_shop_date ON waitlist_entries(shop_id,status,date);
