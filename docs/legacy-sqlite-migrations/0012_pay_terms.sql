-- Pay terms and pay runs. Terms live on the barber (versioned with the staff row); every pay run
-- snapshots the terms it was calculated with, so changing a barber's deal never rewrites history.
-- Standard UK barbershop models covered:
--   COMMISSION  : % of service takings (optionally tiered by weekly takings) + tips
--   CHAIR_RENT  : fixed rent per period; barber keeps 100% of their takings, shop collects rent
--   HOURLY      : hourly rate x rostered (or logged) hours + tips
--   SALARY      : fixed amount per period + tips
--   HYBRID      : base per period + commission above a takings threshold
ALTER TABLE staff ADD COLUMN pay_model TEXT NOT NULL DEFAULT 'COMMISSION' CHECK(pay_model IN ('COMMISSION','CHAIR_RENT','HOURLY','SALARY','HYBRID'));
ALTER TABLE staff ADD COLUMN pay_period TEXT NOT NULL DEFAULT 'WEEKLY' CHECK(pay_period IN ('WEEKLY','FORTNIGHTLY','MONTHLY'));
ALTER TABLE staff ADD COLUMN base_pence INTEGER NOT NULL DEFAULT 0 CHECK(base_pence >= 0);          -- salary / hybrid base per period
ALTER TABLE staff ADD COLUMN hourly_pence INTEGER NOT NULL DEFAULT 0 CHECK(hourly_pence >= 0);      -- hourly model
ALTER TABLE staff ADD COLUMN rent_pence INTEGER NOT NULL DEFAULT 0 CHECK(rent_pence >= 0);          -- chair rent per period
ALTER TABLE staff ADD COLUMN commission_threshold_pence INTEGER NOT NULL DEFAULT 0 CHECK(commission_threshold_pence >= 0); -- hybrid: commission applies above this
ALTER TABLE staff ADD COLUMN commission_tiers TEXT NOT NULL DEFAULT '[]';                            -- JSON [{from_pence, pct}] sorted asc; empty = flat commission_pct
ALTER TABLE staff ADD COLUMN tip_share_pct INTEGER NOT NULL DEFAULT 100 CHECK(tip_share_pct BETWEEN 0 AND 100);
ALTER TABLE staff ADD COLUMN product_commission_pct INTEGER NOT NULL DEFAULT 0 CHECK(product_commission_pct BETWEEN 0 AND 100);
ALTER TABLE staff ADD COLUMN employment TEXT NOT NULL DEFAULT 'SELF_EMPLOYED' CHECK(employment IN ('SELF_EMPLOYED','EMPLOYED'));
ALTER TABLE staff ADD COLUMN pay_notes TEXT NOT NULL DEFAULT '';

CREATE TABLE pay_runs (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  pay_model TEXT NOT NULL,
  terms_json TEXT NOT NULL,          -- snapshot of the staff pay fields at calculation time
  service_pence INTEGER NOT NULL DEFAULT 0,
  tips_pence INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  hours_x100 INTEGER NOT NULL DEFAULT 0,      -- rostered hours * 100
  commission_pence INTEGER NOT NULL DEFAULT 0,
  base_pence INTEGER NOT NULL DEFAULT 0,
  hourly_pence INTEGER NOT NULL DEFAULT 0,
  tip_pence INTEGER NOT NULL DEFAULT 0,       -- share paid to barber
  rent_pence INTEGER NOT NULL DEFAULT 0,      -- charged to barber
  adjustments_json TEXT NOT NULL DEFAULT '[]',-- [{label, pence}] signed; bonuses +, deductions -
  adjustments_pence INTEGER NOT NULL DEFAULT 0,
  net_pence INTEGER NOT NULL,                 -- what the shop pays (negative = barber pays shop)
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','PAID','VOID')),
  paid_method TEXT,
  paid_reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX pay_runs_shop_period ON pay_runs(shop_id,period_from,period_to);
CREATE INDEX pay_runs_staff ON pay_runs(shop_id,staff_id,period_from);
-- One live run per barber per period; voided runs free the slot.
CREATE UNIQUE INDEX pay_runs_unique_live ON pay_runs(shop_id,staff_id,period_from,period_to) WHERE status<>'VOID';
-- Paid runs are frozen apart from voiding.
CREATE TRIGGER pay_runs_paid_frozen BEFORE UPDATE ON pay_runs
BEGIN
  SELECT CASE
    WHEN OLD.status='PAID' AND NOT (NEW.status='VOID' AND NEW.net_pence=OLD.net_pence AND NEW.terms_json=OLD.terms_json) THEN RAISE(ABORT,'pay_run_paid_frozen')
    WHEN OLD.status='VOID' THEN RAISE(ABORT,'pay_run_void_frozen')
  END;
END;
CREATE TRIGGER pay_runs_no_delete BEFORE DELETE ON pay_runs BEGIN SELECT RAISE(ABORT,'pay_run_delete_forbidden'); END;
