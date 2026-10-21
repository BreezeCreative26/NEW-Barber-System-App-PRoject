-- Per-shop switch: may customers sign in with a text code? On by default (existing behaviour);
-- it still needs texts to be on for the shop, because the code is sent by text.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS customer_code_signin INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_customer_code_signin_check;
ALTER TABLE shops ADD CONSTRAINT shops_customer_code_signin_check CHECK (customer_code_signin IN (0,1));
