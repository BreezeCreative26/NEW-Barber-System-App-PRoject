-- OLLO ↔ shop billing: plans, features (entitlements), subscriptions, discounts, usage, invoices.
-- Stripe Billing is the ledger once connected; these tables mirror it and hold the entitlement
-- truth the app enforces. No VAT: tax_pence stays 0 while platform_billing.vat_mode = 'NONE'.

CREATE TABLE IF NOT EXISTS platform_billing (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  vat_mode TEXT NOT NULL DEFAULT 'NONE' CHECK (vat_mode IN ('NONE','UK_20','STRIPE_TAX')),
  vat_number TEXT NOT NULL DEFAULT '',
  trial_days INTEGER NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 90),
  grace_days INTEGER NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 60),
  vat_threshold_pence BIGINT NOT NULL DEFAULT 9000000,
  updated_at BIGINT NOT NULL
);
INSERT INTO platform_billing (id, updated_at) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_pence INTEGER NOT NULL CHECK (monthly_pence >= 0),
  included_seats INTEGER NOT NULL DEFAULT 1 CHECK (included_seats >= 0),
  seat_pence INTEGER NOT NULL DEFAULT 0 CHECK (seat_pence >= 0),
  stripe_price_id TEXT NOT NULL DEFAULT '',
  stripe_seat_price_id TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
INSERT INTO plans (id, name, monthly_pence, included_seats, seat_pence, sort, created_at, updated_at)
VALUES ('core', 'OLLO', 2499, 1, 799, 0, 0, 0) ON CONFLICT (id) DO NOTHING;

-- kind: ADDON = priced monthly + optional metered units; FLAG = free capability toggled by plan/admin.
CREATE TABLE IF NOT EXISTS features (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('ADDON','FLAG')),
  monthly_pence INTEGER NOT NULL DEFAULT 0 CHECK (monthly_pence >= 0),
  unit TEXT NOT NULL DEFAULT '',
  unit_pence INTEGER NOT NULL DEFAULT 0 CHECK (unit_pence >= 0),
  included_units INTEGER NOT NULL DEFAULT 0 CHECK (included_units >= 0),
  in_plan INTEGER NOT NULL DEFAULT 0 CHECK (in_plan IN (0,1)),
  stripe_price_id TEXT NOT NULL DEFAULT '',
  stripe_metered_price_id TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
INSERT INTO features (key, name, description, kind, monthly_pence, unit, unit_pence, included_units, in_plan, sort, updated_at) VALUES
  ('online_booking', 'Online booking', 'Public booking page and customer accounts.', 'FLAG', 0, '', 0, 0, 1, 10, 0),
  ('waitlist',       'Waitlist',        'Automatic offers when a slot frees up.',        'FLAG', 0, '', 0, 0, 1, 20, 0),
  ('shop_page',      'Shop page & reviews', 'Public shop page, gallery and reviews.',   'FLAG', 0, '', 0, 0, 1, 30, 0),
  ('card_payments',  'Card payments',   'Deposits, pay links and tap at the chair (2.2% + 20p per payment).', 'FLAG', 0, '', 0, 0, 1, 40, 0),
  ('sms',            'Text messages',   'Confirmations and reminders by SMS.',            'ADDON', 0, 'text', 6, 0, 1, 50, 0),
  ('whatsapp',       'WhatsApp',        'Confirmations and reminders by WhatsApp.',       'ADDON', 0, 'message', 3, 0, 1, 60, 0),
  ('ai_concierge',   'AI Concierge',    'Answers the phone 24/7, books, moves and cancels. 300 minutes included, then 12p a minute.', 'ADDON', 4900, 'minute', 12, 300, 0, 70, 0)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS shop_subscriptions (
  shop_id TEXT PRIMARY KEY REFERENCES shops(id),
  plan_id TEXT NOT NULL REFERENCES plans(id) DEFAULT 'core',
  status TEXT NOT NULL DEFAULT 'TRIAL' CHECK (status IN ('TRIAL','ACTIVE','PAST_DUE','PAUSED','CANCELLED')),
  stripe_customer_id TEXT NOT NULL DEFAULT '',
  stripe_subscription_id TEXT NOT NULL DEFAULT '',
  seats INTEGER NOT NULL DEFAULT 1 CHECK (seats >= 1),
  trial_ends_at BIGINT,
  current_period_start BIGINT,
  current_period_end BIGINT,
  past_due_since BIGINT,
  cancel_at BIGINT,
  billing_email TEXT NOT NULL DEFAULT '',
  billing_name TEXT NOT NULL DEFAULT '',
  address_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Per-shop entitlement rows. ADMIN_BLOCK beats everything; ADMIN_GRANT beats plan/addon.
CREATE TABLE IF NOT EXISTS shop_features (
  shop_id TEXT NOT NULL REFERENCES shops(id),
  feature_key TEXT NOT NULL REFERENCES features(key),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  source TEXT NOT NULL CHECK (source IN ('PLAN','ADDON','ADMIN_GRANT','ADMIN_BLOCK')),
  stripe_item_id TEXT NOT NULL DEFAULT '',
  stripe_metered_item_id TEXT NOT NULL DEFAULT '',
  granted_by TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  starts_at BIGINT NOT NULL,
  ends_at BIGINT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, feature_key)
);

CREATE TABLE IF NOT EXISTS discounts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('PERCENT','FIXED','FREE_MONTHS','SEATS_FREE')),
  value INTEGER NOT NULL CHECK (value >= 0),
  applies_to TEXT NOT NULL DEFAULT 'ALL',
  duration TEXT NOT NULL DEFAULT 'ONCE' CHECK (duration IN ('ONCE','REPEATING','FOREVER')),
  duration_months INTEGER NOT NULL DEFAULT 1 CHECK (duration_months >= 1),
  max_redemptions INTEGER,
  redeemed INTEGER NOT NULL DEFAULT 0,
  starts_at BIGINT,
  ends_at BIGINT,
  stripe_coupon_id TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS shop_discounts (
  shop_id TEXT NOT NULL REFERENCES shops(id),
  discount_id TEXT NOT NULL REFERENCES discounts(id),
  applied_at BIGINT NOT NULL,
  applied_by TEXT NOT NULL DEFAULT '',
  ends_at BIGINT,
  PRIMARY KEY (shop_id, discount_id)
);

-- Metered usage, one row per billable event, idempotent on the source record.
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  feature_key TEXT NOT NULL REFERENCES features(key),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  unit_pence INTEGER NOT NULL CHECK (unit_pence >= 0),
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  period_key TEXT NOT NULL,
  reported_at BIGINT,
  stripe_usage_record_id TEXT NOT NULL DEFAULT '',
  UNIQUE (ref_type, ref_id)
);
CREATE INDEX IF NOT EXISTS usage_shop_period ON usage_events (shop_id, period_key, feature_key);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  stripe_invoice_id TEXT NOT NULL DEFAULT '',
  number TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('DRAFT','OPEN','PAID','VOID','UNCOLLECTIBLE')),
  period_start BIGINT NOT NULL,
  period_end BIGINT NOT NULL,
  subtotal_pence INTEGER NOT NULL DEFAULT 0,
  discount_pence INTEGER NOT NULL DEFAULT 0,
  tax_pence INTEGER NOT NULL DEFAULT 0,
  total_pence INTEGER NOT NULL DEFAULT 0,
  paid_pence INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GBP',
  hosted_url TEXT NOT NULL DEFAULT '',
  pdf_url TEXT NOT NULL DEFAULT '',
  due_at BIGINT,
  paid_at BIGINT,
  lines_json TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_stripe ON invoices (stripe_invoice_id) WHERE stripe_invoice_id <> '';
CREATE INDEX IF NOT EXISTS invoices_shop ON invoices (shop_id, period_start DESC);

CREATE TABLE IF NOT EXISTS invoice_adjustments (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  invoice_id TEXT REFERENCES invoices(id),
  kind TEXT NOT NULL CHECK (kind IN ('CREDIT','CHARGE')),
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  stripe_id TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

-- Human-readable billing timeline per shop (seat changes, add-ons, grants, dunning) for the Billing tab and admin.
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_events_shop ON billing_events (shop_id, created_at DESC);

-- Platform admins (OLLO staff). Seeded from OLLO_ADMIN_EMAILS on first admin request.
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id TEXT PRIMARY KEY REFERENCES app_users(id),
  role TEXT NOT NULL DEFAULT 'SUPPORT' CHECK (role IN ('SUPER','SUPPORT','FINANCE')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  shop_id TEXT,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_shop ON admin_audit (shop_id, created_at DESC);
CREATE TABLE IF NOT EXISTS support_notes (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  admin_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Every existing shop starts on a trial from today.
INSERT INTO shop_subscriptions (shop_id, plan_id, status, seats, trial_ends_at, created_at, updated_at)
SELECT s.id, 'core', 'TRIAL',
       GREATEST(1, (SELECT COUNT(*) FROM staff st WHERE st.shop_id = s.id AND st.active = 1)),
       (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT + 14 * 86400000,
       (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
FROM shops s
ON CONFLICT (shop_id) DO NOTHING;
