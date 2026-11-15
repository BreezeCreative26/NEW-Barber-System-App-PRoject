-- A service can always show its price as "From £x" (the final price can go up in the chair).
-- Prices that differ by barber already show "From" automatically.
ALTER TABLE services ADD COLUMN IF NOT EXISTS price_from INTEGER NOT NULL DEFAULT 0;
