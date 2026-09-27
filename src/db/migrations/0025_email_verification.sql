-- Owner / staff login-email verification. Signup and invite-accept send a welcome email carrying a
-- one-time link; clicking it stamps app_users.email_verified_at. Nothing is gated on it yet — the
-- workspace shows a soft "confirm your email" nudge until it's done, and password-reset mail is
-- only useful if the address is real.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_verified_at BIGINT;
CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS email_verifications_user ON email_verifications(user_id, used_at);
