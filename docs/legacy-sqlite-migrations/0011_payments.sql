-- Payments ledger (Model A): the wallet is a record of money taken at the chair, never a balance
-- the app holds. One row per payment; a completed visit may have several (split tender).
-- Commission is snapshotted per row from the barber's rate at the time, so later rate changes
-- never rewrite history. Tips go 100% to the barber.
ALTER TABLE staff ADD COLUMN commission_pct INTEGER NOT NULL DEFAULT 50 CHECK(commission_pct BETWEEN 0 AND 100);
ALTER TABLE shops ADD COLUMN till_access TEXT NOT NULL DEFAULT 'OWNER' CHECK(till_access IN ('OWNER','ALL'));

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  booking_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  customer_id TEXT,
  date TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('CARD','CASH','TRANSFER','VOUCHER')),
  service_pence INTEGER NOT NULL CHECK(service_pence >= 0),
  tip_pence INTEGER NOT NULL DEFAULT 0 CHECK(tip_pence >= 0),
  discount_pence INTEGER NOT NULL DEFAULT 0 CHECK(discount_pence >= 0),
  commission_pct INTEGER NOT NULL CHECK(commission_pct BETWEEN 0 AND 100),
  note TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL,
  voided_at INTEGER,
  void_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(shop_id,booking_id) REFERENCES bookings(shop_id,id),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX payments_shop_date ON payments(shop_id,date,created_at);
CREATE INDEX payments_booking ON payments(shop_id,booking_id);
CREATE INDEX payments_staff_date ON payments(shop_id,staff_id,date);

-- Ledger rows are append-only apart from voiding (set once, never cleared).
CREATE TRIGGER payments_immutable BEFORE UPDATE ON payments
BEGIN
  SELECT CASE
    WHEN OLD.voided_at IS NOT NULL THEN RAISE(ABORT,'payment_already_voided')
    WHEN NEW.id<>OLD.id OR NEW.shop_id<>OLD.shop_id OR NEW.booking_id<>OLD.booking_id OR NEW.staff_id<>OLD.staff_id
      OR NEW.method<>OLD.method OR NEW.service_pence<>OLD.service_pence OR NEW.tip_pence<>OLD.tip_pence
      OR NEW.discount_pence<>OLD.discount_pence OR NEW.commission_pct<>OLD.commission_pct OR NEW.created_at<>OLD.created_at
      THEN RAISE(ABORT,'payment_immutable')
    WHEN NEW.voided_at IS NULL THEN RAISE(ABORT,'payment_void_required')
  END;
END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT,'payment_delete_forbidden'); END;
-- A payment must belong to a visit that actually happened (in service or completed).
CREATE TRIGGER payments_visit_state BEFORE INSERT ON payments
BEGIN
  SELECT CASE
    WHEN (SELECT status FROM bookings WHERE shop_id=NEW.shop_id AND id=NEW.booking_id) NOT IN ('IN_SERVICE','COMPLETED')
      THEN RAISE(ABORT,'payment_visit_not_in_service')
  END;
END;
