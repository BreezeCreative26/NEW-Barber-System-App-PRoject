-- Proof of who agreed to (or stopped) marketing, when, and how. Append-only record for UK GDPR / PECR.
CREATE TABLE IF NOT EXISTS marketing_consent_log (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('IN','OUT')),
  source TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS marketing_consent_log_customer ON marketing_consent_log(shop_id, customer_id, at);
