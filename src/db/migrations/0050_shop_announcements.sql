-- Shops telling their own customers about their new online booking page.
CREATE TABLE IF NOT EXISTS shop_campaigns (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'EMAIL' CHECK (channel IN ('SMS','EMAIL','BOTH')),
  audience TEXT NOT NULL DEFAULT 'ALL' CHECK (audience IN ('ALL','OPTED_IN')),
  subject TEXT NOT NULL DEFAULT '',
  heading TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sms_body TEXT NOT NULL DEFAULT '',
  cta_label TEXT NOT NULL DEFAULT '',
  sms_count INTEGER NOT NULL DEFAULT 0,
  email_count INTEGER NOT NULL DEFAULT 0,
  sent_by TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  send_after BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shop_campaigns_shop ON shop_campaigns(shop_id, created_at DESC);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS announce_unsub_at BIGINT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS unsub_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS customers_unsub_token ON customers(unsub_token) WHERE unsub_token IS NOT NULL;
