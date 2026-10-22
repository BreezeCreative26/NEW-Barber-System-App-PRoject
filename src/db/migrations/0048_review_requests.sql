-- Review requests after a visit: email is free and on by default; text is opt-in because texts are billed.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS review_ask_email INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS review_ask_sms INTEGER NOT NULL DEFAULT 0;
