-- Customer accounts v2: email + password sign-in (the one-time mobile code stays as a fallback and
-- as the recovery path), a per-shop installable web app, and push notifications for their visits.
--
-- customer_accounts is global (one person, one account) and linked per shop through
-- customer_account_links. Email becomes the sign-in name; it must be unique when set.
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS password_salt TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS password_set_at BIGINT;
-- Accounts created before this migration may share an email (rare: family bookings). Only new
-- registrations are held to uniqueness; the partial index skips blanks.
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_email ON customer_accounts(lower(email)) WHERE email <> '';

-- Password reset / first-time "set your password" links. One live token per account; the raw
-- token goes in the email or text, only its hash is stored.
CREATE TABLE IF NOT EXISTS customer_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('RESET','WELCOME')),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS customer_reset_tokens_account ON customer_reset_tokens(account_id);

-- Web Push subscriptions from the installed shop app. Scoped per shop so a customer who installs
-- two shops' apps gets each shop's notifications from that app only.
CREATE TABLE IF NOT EXISTS customer_push_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  failures INTEGER NOT NULL DEFAULT 0,
  UNIQUE (shop_id, endpoint)
);
CREATE INDEX IF NOT EXISTS customer_push_account ON customer_push_subscriptions(account_id, shop_id);

-- Outbox gains a PUSH channel next to SMS/EMAIL/WA.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check CHECK (channel IN ('SMS','EMAIL','WA','PUSH'));
