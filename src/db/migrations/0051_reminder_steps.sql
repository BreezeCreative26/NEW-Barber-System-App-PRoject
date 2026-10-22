-- Reminder schedule (hours before the visit, up to three) and quiet hours for reminders.
-- Empty steps means the classic pair: the shop's day-before hours and a short one 2h before.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_reminder_steps TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_quiet_on INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_quiet_start INTEGER NOT NULL DEFAULT 1260;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_quiet_end INTEGER NOT NULL DEFAULT 480;
