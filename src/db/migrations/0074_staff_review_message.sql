-- Each barber can personalise the message their customers see in the "how did I do?" review pop-up.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS review_message TEXT NOT NULL DEFAULT '';
