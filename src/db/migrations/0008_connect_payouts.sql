-- OLLO as a Stripe Connect platform. Every shop and every barber can hold an Express connected
-- account. Card money is charged on the platform; pay runs move it out with Transfers. Cash never
-- enters. See docs/PAYMENTS.md.

-- Connected accounts: one per (shop | staff). Status mirrors Stripe's account.updated webhook —
-- charges_enabled / payouts_enabled are separate flags on purpose (BUILD_PLAN §7).
CREATE TABLE IF NOT EXISTS connected_accounts (
  id TEXT PRIMARY KEY,                       -- acct_…
  shop_id TEXT NOT NULL REFERENCES shops(id),
  owner_type TEXT NOT NULL CHECK(owner_type IN ('SHOP','STAFF')),
  owner_id TEXT NOT NULL,                    -- shop id or staff id
  email TEXT NOT NULL DEFAULT '',
  details_submitted INTEGER NOT NULL DEFAULT 0,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  requirements_json TEXT NOT NULL DEFAULT '[]',
  payout_schedule TEXT NOT NULL DEFAULT 'daily',
  disabled_reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(shop_id, owner_type, owner_id)
);
-- Back-fill: shops that already connected via 0007 get a row here.
INSERT INTO connected_accounts(id, shop_id, owner_type, owner_id, created_at, updated_at)
  SELECT stripe_account_id, id, 'SHOP', id, EXTRACT(EPOCH FROM now())*1000, EXTRACT(EPOCH FROM now())*1000 FROM shops WHERE stripe_account_id<>''
  ON CONFLICT DO NOTHING;

-- Platform-wide payment policy (one row, key/value in platform_kv is too loose for money):
-- application fee OLLO keeps per card payment, and the payout tier shops may use.
CREATE TABLE IF NOT EXISTS platform_payments (
  id INTEGER PRIMARY KEY CHECK(id=1),
  fee_bps INTEGER NOT NULL DEFAULT 150 CHECK(fee_bps BETWEEN 0 AND 2000),   -- 1.5 %
  fee_fixed_pence INTEGER NOT NULL DEFAULT 0 CHECK(fee_fixed_pence BETWEEN 0 AND 500),
  fast_payouts INTEGER NOT NULL DEFAULT 1 CHECK(fast_payouts IN (0,1)),    -- allow transfers against the float
  float_alert_pence INTEGER NOT NULL DEFAULT 200000,                          -- warn when available < this
  updated_at BIGINT NOT NULL
);
INSERT INTO platform_payments(id, updated_at) VALUES(1, EXTRACT(EPOCH FROM now())*1000) ON CONFLICT DO NOTHING;

-- Shop payout policy: how often pay runs are approved automatically and the speed tier.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS payout_tier TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS payrun_auto TEXT NOT NULL DEFAULT 'OFF';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS payrun_reserve_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_payout_check;
ALTER TABLE shops ADD CONSTRAINT shops_payout_check CHECK (payout_tier IN ('STANDARD','FAST') AND payrun_auto IN ('OFF','DAILY','WEEKLY') AND payrun_reserve_bps BETWEEN 0 AND 5000);

-- Card payments taken through the platform carry Stripe references so refunds/disputes reverse the
-- right transfers. method ONLINE (deposits) and CARD via Terminal both use these.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT NOT NULL DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_charge TEXT NOT NULL DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_fee_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS platform_fee_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS pay_run_id TEXT;                -- which run settled it
CREATE INDEX IF NOT EXISTS payments_unsettled ON payments(shop_id, staff_id, date) WHERE pay_run_id IS NULL AND voided_at IS NULL;

-- Pay runs: split what was collected by card (transferable) from cash (already in someone's hand),
-- and record the Stripe movements. Status gains TRANSFERRED (money moved by OLLO) alongside PAID
-- (owner attested an external settlement of any cash residual).
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS card_service_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS card_tips_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS cash_service_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS cash_tips_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS transfer_pence INTEGER NOT NULL DEFAULT 0;      -- to barber via Stripe
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS shop_transfer_pence INTEGER NOT NULL DEFAULT 0; -- to shop via Stripe
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS reserve_pence INTEGER NOT NULL DEFAULT 0;       -- held back against disputes
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS cash_residual_pence INTEGER NOT NULL DEFAULT 0; -- settle by hand (+ owed to barber, − owed to shop)
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS transfer_group TEXT NOT NULL DEFAULT '';
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS transferred_at BIGINT;
ALTER TABLE pay_runs DROP CONSTRAINT IF EXISTS pay_runs_status_check;
ALTER TABLE pay_runs ADD CONSTRAINT pay_runs_status_check CHECK(status IN ('DRAFT','APPROVED','TRANSFERRED','PAID','VOID'));

-- Every Stripe Transfer / reversal we create, for the ledger and for reconciliation.
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,                       -- tr_… or trr_…
  shop_id TEXT NOT NULL REFERENCES shops(id),
  pay_run_id TEXT,
  account_id TEXT NOT NULL,                  -- destination connected account
  owner_type TEXT NOT NULL CHECK(owner_type IN ('SHOP','STAFF')),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('PAYOUT','REVERSAL','ADJUSTMENT')),
  amount_pence INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  transfer_group TEXT NOT NULL DEFAULT '',
  reverses TEXT,                              -- transfer id this reversal undoes
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','PAID','FAILED','REVERSED')),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_run ON transfers(shop_id, pay_run_id);
CREATE INDEX IF NOT EXISTS transfers_owner ON transfers(shop_id, owner_type, owner_id, created_at);

-- Bank payouts Stripe made from a connected account (from payout.* webhooks) so wallets can show
-- "reached your bank".
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,                       -- po_…
  account_id TEXT NOT NULL,
  amount_pence INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL,                      -- pending | in_transit | paid | failed | canceled
  arrival_date TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'standard',   -- standard | instant
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS payouts_account ON payouts(account_id, created_at);

-- Disputes against platform charges: reversed against the linked transfers.
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,                       -- dp_…
  shop_id TEXT NOT NULL,
  payment_id TEXT,
  charge TEXT NOT NULL,
  amount_pence INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  reversed INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
