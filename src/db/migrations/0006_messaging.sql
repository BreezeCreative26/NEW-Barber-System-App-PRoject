-- Real messaging: the outbox becomes a delivery queue and the shop gets messaging settings.
-- notifications: subject (email), html (email body; SMS uses body), provider + provider_id for the
-- delivery receipt, attempts/next_attempt_at for retry, error for the last failure. Statuses gain
-- SENDING. Existing SKIPPED rows stay as history.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS html TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider_id TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS next_attempt_at BIGINT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS error TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check CHECK(status IN ('QUEUED','SENDING','SENT','FAILED','SKIPPED'));
CREATE INDEX IF NOT EXISTS notifications_due ON notifications(status, next_attempt_at) WHERE status IN ('QUEUED','SENDING');
CREATE INDEX IF NOT EXISTS notifications_related ON notifications(shop_id, related_type, related_id, template);

-- Shop messaging preferences. Providers themselves are platform-level (env), the shop chooses what
-- goes out and how it is signed.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_sms INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_email INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_reminders INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_reminder_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_reply_to TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_sms_sender TEXT NOT NULL DEFAULT '';
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_msg_flags_check;
ALTER TABLE shops ADD CONSTRAINT shops_msg_flags_check CHECK (msg_sms IN (0,1) AND msg_email IN (0,1) AND msg_reminders IN (0,1) AND msg_reminder_hours BETWEEN 1 AND 72);

-- Reminders are sent once per booking per kind; the related index above plus this uniqueness keeps
-- a cron overlap from double-sending.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_once_per_booking ON notifications(shop_id, related_id, template, channel) WHERE template IN ('booking_reminder','booking_reminder_soon','booking_confirmed');

-- Platform-level cursor for lazy/cron sweeps (last reminder sweep etc.).
CREATE TABLE IF NOT EXISTS platform_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL);
