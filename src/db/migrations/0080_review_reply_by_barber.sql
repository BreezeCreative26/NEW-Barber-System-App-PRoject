-- Barbers can reply to their own reviews. reply_staff_id = the barber who wrote the reply (their
-- photo and name show with it on the website); NULL = a reply from the shop.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply_staff_id TEXT;
