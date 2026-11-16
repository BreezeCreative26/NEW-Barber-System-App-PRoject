-- "Hold a space": how long a held time is kept for the customer by default (minutes).
-- The barber can still pick another length per hold; this is what the Hold screen starts on.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS slot_hold_min INTEGER NOT NULL DEFAULT 240;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='shops_slot_hold_min_check') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_slot_hold_min_check CHECK (slot_hold_min BETWEEN 15 AND 2880);
  END IF;
END $$;
