-- Shop setup: guided wizard state, shop contact details with verification, owner alerts, invite
-- delivery tracking, password resets, contact verification codes.

-- Shop-level contact (distinct from the public shop page, which can show a different number).
-- kind drives the starter service menu and copy; setup_json is the wizard's resumable state
-- ({step, done:[...], completed_at}); notify_json is the owner/manager alert preferences.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS phone_verified_at BIGINT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS email_verified_at BIGINT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'BARBER';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS notify_json TEXT NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_kind_check') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_kind_check CHECK (kind IN ('BARBER','HAIR','SALON'));
  END IF;
END $$;

-- Invites: how they went out and how often; phone for SMS delivery.
ALTER TABLE staff_invitations ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE staff_invitations ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'EMAIL';
ALTER TABLE staff_invitations ADD COLUMN IF NOT EXISTS sent_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE staff_invitations ADD COLUMN IF NOT EXISTS last_sent_at BIGINT;
ALTER TABLE staff_invitations ADD COLUMN IF NOT EXISTS invited_by TEXT NOT NULL DEFAULT '';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitations_channel_check') THEN
    ALTER TABLE staff_invitations ADD CONSTRAINT invitations_channel_check CHECK (channel IN ('EMAIL','SMS','BOTH','LINK'));
  END IF;
END $$;

-- Forgot password: single-use, 30 min, hashed token. Delivered by email and (when the account's
-- shop has a verified mobile for them) SMS.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id, created_at);

-- Verification codes for the shop's own phone/email (6 digits, 10 min, 5 attempts).
CREATE TABLE IF NOT EXISTS contact_codes (
  shop_id TEXT NOT NULL REFERENCES shops(id),
  kind TEXT NOT NULL CHECK (kind IN ('PHONE','EMAIL')),
  target TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, kind)
);
