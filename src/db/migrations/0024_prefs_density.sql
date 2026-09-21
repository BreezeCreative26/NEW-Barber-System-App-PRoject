-- Per-user UI preferences (calendar density today; more later) and the shop's default density.
-- prefs_json is a small sparse map; unknown keys are ignored on read so the client can add keys
-- without a migration.
ALTER TABLE app_memberships ADD COLUMN IF NOT EXISTS prefs_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS calendar_density TEXT NOT NULL DEFAULT 'STANDARD';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_calendar_density_check') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_calendar_density_check CHECK (calendar_density IN ('COMPACT','STANDARD','LARGE'));
  END IF;
END $$;
