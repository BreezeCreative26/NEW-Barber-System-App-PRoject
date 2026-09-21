-- Pay runs v2: recurring deductions (chair/room rent, % splits, other) independent of the pay basis,
-- and a full statement (staff share, owner share, deductions, owed both ways) stored on each run.

-- Deductions live on the staff record like commission tiers: JSON array of
--   { id, label, kind: FIXED|PERCENT_OF_TAKINGS|PERCENT_OF_STAFF_SHARE, amount_pence, pct_x100,
--     cadence: WEEKLY|FORTNIGHTLY|MONTHLY|PER_RUN, proration: FULL|BY_DAYS, waive_on_leave: 0|1, active: 0|1 }
ALTER TABLE staff ADD COLUMN IF NOT EXISTS deductions_json TEXT NOT NULL DEFAULT '[]';

-- CHAIR_RENT now means "barber keeps 100% of takings"; the rent itself becomes a deduction row so
-- it can sit alongside other charges and be prorated / waived on leave. Same numbers as before.
UPDATE staff SET deductions_json = json_build_array(json_build_object(
  'id', 'rent-' || left(id, 8), 'label', 'Chair rent', 'kind', 'FIXED', 'amount_pence', rent_pence, 'pct_x100', 0,
  'cadence', pay_period, 'proration', 'FULL', 'waive_on_leave', 0, 'active', 1))::text
WHERE pay_model = 'CHAIR_RENT' AND rent_pence > 0 AND deductions_json = '[]';

-- Statement fields on the run (all derived at creation; frozen with the terms snapshot).
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS staff_share_pence INTEGER NOT NULL DEFAULT 0;   -- share of sales before tips/deductions
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS owner_share_pence INTEGER NOT NULL DEFAULT 0;   -- sales − staff share
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS deductions_json TEXT NOT NULL DEFAULT '[]';     -- [{label,pence,detail}]
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS deductions_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS owed_to_business_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS leave_days REAL NOT NULL DEFAULT 0;             -- approved leave days in the period
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS view_token TEXT NOT NULL DEFAULT '';

-- Backfill old runs so history reads consistently (derived columns only; the freeze trigger is
-- paused for this statement because paid/void runs are otherwise immutable).
ALTER TABLE pay_runs DISABLE TRIGGER pay_runs_paid_frozen;
UPDATE pay_runs SET
  staff_share_pence = CASE WHEN pay_model = 'CHAIR_RENT' THEN service_pence ELSE commission_pence + base_pence + hourly_pence END,
  owner_share_pence = GREATEST(0, service_pence - CASE WHEN pay_model = 'CHAIR_RENT' THEN service_pence ELSE commission_pence + base_pence + hourly_pence END),
  deductions_json = CASE WHEN rent_pence > 0 THEN json_build_array(json_build_object('label','Chair rent','pence',rent_pence,'detail','from terms'))::text ELSE '[]' END,
  deductions_pence = rent_pence,
  owed_to_business_pence = GREATEST(0, service_pence - CASE WHEN pay_model = 'CHAIR_RENT' THEN service_pence ELSE commission_pence + base_pence + hourly_pence END) + rent_pence
WHERE staff_share_pence = 0 AND owner_share_pence = 0 AND deductions_pence = 0;
ALTER TABLE pay_runs ENABLE TRIGGER pay_runs_paid_frozen;

-- Owners can hide the owner's-share line from barbers' statements.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pay_show_owner_share INTEGER NOT NULL DEFAULT 1 CHECK (pay_show_owner_share IN (0,1));
