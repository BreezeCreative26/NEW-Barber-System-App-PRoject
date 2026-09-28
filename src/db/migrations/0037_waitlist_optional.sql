-- Waiting list is an optional feature. Existing shops keep it on (they may have a live queue);
-- shops created from now on start with it off and switch it on from Settings › Waiting list.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS waitlist_enabled INTEGER NOT NULL DEFAULT 1;
UPDATE shops SET waitlist_enabled = 0 WHERE NOT EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.shop_id = shops.id);
