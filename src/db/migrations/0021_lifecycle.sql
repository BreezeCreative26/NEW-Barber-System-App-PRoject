-- Lifecycle emails (trial ending, overdue), broadcasts to shop owners, admin alerts, MRR snapshots.

-- One row per (shop, message key) so trial/overdue nudges are sent once per state.
CREATE TABLE IF NOT EXISTS lifecycle_sends (
  shop_id TEXT NOT NULL REFERENCES shops(id),
  key TEXT NOT NULL,
  sent_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, key)
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  cta_label TEXT NOT NULL DEFAULT '',
  cta_url TEXT NOT NULL DEFAULT '',
  segment_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENDING','SENT','CANCELLED')),
  recipients INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  sent_at BIGINT,
  test_sent_to TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  email TEXT NOT NULL,
  notification_id TEXT,
  PRIMARY KEY (broadcast_id, shop_id, email)
);

-- Things OLLO staff should hear about. Read in Admin → Alerts; emailed as a digest to OLLO_ALERT_EMAIL.
CREATE TABLE IF NOT EXISTS admin_alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARN','CRIT')),
  shop_id TEXT REFERENCES shops(id),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  acked_at BIGINT,
  acked_by TEXT NOT NULL DEFAULT '',
  emailed_at BIGINT
);
CREATE INDEX IF NOT EXISTS admin_alerts_open ON admin_alerts (acked_at, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS admin_alerts_dedupe ON admin_alerts (dedupe_key) WHERE dedupe_key <> '' AND acked_at IS NULL;

-- Daily MRR / shop-count snapshot for trend charts.
CREATE TABLE IF NOT EXISTS mrr_snapshots (
  day TEXT PRIMARY KEY,
  mrr_pence BIGINT NOT NULL,
  active INTEGER NOT NULL,
  trial INTEGER NOT NULL,
  past_due INTEGER NOT NULL,
  paused INTEGER NOT NULL,
  cancelled INTEGER NOT NULL,
  new_shops INTEGER NOT NULL DEFAULT 0,
  converted INTEGER NOT NULL DEFAULT 0,
  churned INTEGER NOT NULL DEFAULT 0,
  taken_at BIGINT NOT NULL
);

-- When a trial converted / a subscription cancelled (for churn + conversion).
ALTER TABLE shop_subscriptions ADD COLUMN IF NOT EXISTS activated_at BIGINT;
ALTER TABLE shop_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at BIGINT;
