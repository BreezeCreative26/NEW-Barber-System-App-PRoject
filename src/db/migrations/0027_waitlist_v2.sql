-- Waiting list v2: debounced notifications, order-vs-everyone mode, time windows and date ranges.
--
-- Shop settings
--   waitlist_mode        ORDER    = soft-hold offer to the next person in line (cascades on decline/expiry)
--                        EVERYONE = tell every matching customer at once; first to book wins, no hold
--   waitlist_delay_min   minutes to wait after a slot frees before anyone is told. Gives the shop
--                        time to re-book a cancelled slot by hand without a text going out. 0 = instant.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS waitlist_mode TEXT NOT NULL DEFAULT 'ORDER';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS waitlist_delay_min INTEGER NOT NULL DEFAULT 5;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='shops_waitlist_mode_check') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_waitlist_mode_check CHECK (waitlist_mode IN ('ORDER','EVERYONE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='shops_waitlist_delay_check') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_waitlist_delay_check CHECK (waitlist_delay_min BETWEEN 0 AND 60);
  END IF;
END $$;

-- Entries: a time window on the day (minutes from midnight) and an optional end date for a range.
-- `date` stays the start date so every existing query/index keeps working; date_to defaults to date.
-- daypart is kept as the customer's quick pick and is derived from the window on write.
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS date_to TEXT;
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS from_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS to_min INTEGER NOT NULL DEFAULT 1440;
UPDATE waitlist_entries SET date_to = date WHERE date_to IS NULL;
UPDATE waitlist_entries SET from_min = CASE daypart WHEN 'AFTERNOON' THEN 720 WHEN 'EVENING' THEN 1020 ELSE 0 END,
                            to_min   = CASE daypart WHEN 'MORNING' THEN 720 WHEN 'AFTERNOON' THEN 1020 ELSE 1440 END
  WHERE from_min = 0 AND to_min = 1440 AND daypart <> 'ANY';
ALTER TABLE waitlist_entries ALTER COLUMN date_to SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='waitlist_window_check') THEN
    ALTER TABLE waitlist_entries ADD CONSTRAINT waitlist_window_check CHECK (from_min >= 0 AND to_min <= 1440 AND from_min < to_min AND date_to >= date);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS waitlist_shop_range ON waitlist_entries(shop_id, status, date, date_to);

-- Freed slots waiting out the delay. One row per (shop, barber, date, time); re-freeing the same
-- slot just pushes notify_at back. The sweep processes rows whose notify_at has passed and, if the
-- slot is still free, offers/announces it; if the shop has filled it by hand, the row is deleted.
CREATE TABLE IF NOT EXISTS waitlist_pending_slots (
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  freed_at BIGINT NOT NULL,
  notify_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, staff_id, date, start_min)
);
CREATE INDEX IF NOT EXISTS waitlist_pending_due ON waitlist_pending_slots(notify_at);

-- EVERYONE mode: which entries were told about which slot, so nobody is texted twice for one slot.
CREATE TABLE IF NOT EXISTS waitlist_announcements (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  entry_id TEXT NOT NULL REFERENCES waitlist_entries(id),
  staff_id TEXT NOT NULL, date TEXT NOT NULL, start_min INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (entry_id, staff_id, date, start_min)
);

-- Legacy writers (seed, older clients) don't supply date_to: default it to the start date.
CREATE OR REPLACE FUNCTION waitlist_entries_defaults() RETURNS trigger AS $$
BEGIN
  IF NEW.date_to IS NULL THEN NEW.date_to := NEW.date; END IF;
  IF NEW.from_min IS NULL THEN NEW.from_min := 0; END IF;
  IF NEW.to_min IS NULL THEN NEW.to_min := 1440; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS waitlist_entries_defaults ON waitlist_entries;
CREATE TRIGGER waitlist_entries_defaults BEFORE INSERT OR UPDATE ON waitlist_entries FOR EACH ROW EXECUTE FUNCTION waitlist_entries_defaults();
