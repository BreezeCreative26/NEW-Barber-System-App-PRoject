-- Shop display currency (ISO 4217). Prices stay in minor units; this only changes formatting.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'GBP';
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_currency_check;
ALTER TABLE shops ADD CONSTRAINT shops_currency_check CHECK (currency ~ '^[A-Z]{3}$');
