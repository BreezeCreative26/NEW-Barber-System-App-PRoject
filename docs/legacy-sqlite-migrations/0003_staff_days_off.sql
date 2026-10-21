CREATE TABLE staff_days_off (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(shop_id,staff_id,date),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX staff_days_off_dates ON staff_days_off(shop_id,date,staff_id);

-- Revalidate inside the write, even when an earlier availability read succeeded.
CREATE TRIGGER booking_staff_day_off_insert BEFORE INSERT ON bookings
BEGIN
  SELECT RAISE(ABORT,'staff_day_off') WHERE EXISTS (
    SELECT 1 FROM staff_days_off d WHERE d.shop_id=NEW.shop_id
    AND d.staff_id=NEW.staff_id AND d.date=NEW.date
  );
END;
CREATE TRIGGER booking_staff_day_off_move BEFORE UPDATE OF staff_id,date,start_at,end_at ON bookings
BEGIN
  SELECT RAISE(ABORT,'staff_day_off') WHERE EXISTS (
    SELECT 1 FROM staff_days_off d WHERE d.shop_id=NEW.shop_id
    AND d.staff_id=NEW.staff_id AND d.date=NEW.date
  );
END;
