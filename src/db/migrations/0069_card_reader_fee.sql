-- Card reader fee (the shop's own card machine, e.g. Revolut): a % of each card-reader payment that
-- the barber pays on their own transactions. Shown in the wallet and pay runs as the first deduction,
-- before chair rent. Basis points: 150 = 1.5%. Off (0) unless the shop sets it in Settings → Payments.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS card_reader_fee_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_card_reader_fee_bps_check;
ALTER TABLE shops ADD CONSTRAINT shops_card_reader_fee_bps_check CHECK (card_reader_fee_bps BETWEEN 0 AND 1000);
