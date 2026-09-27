-- Logo uploads. The API has accepted kind='logo' since the shop page shipped, but the check
-- constraint was never widened, so every logo upload failed with a database error.
ALTER TABLE shop_media DROP CONSTRAINT IF EXISTS shop_media_kind_check;
ALTER TABLE shop_media ADD CONSTRAINT shop_media_kind_check CHECK (kind IN ('cover','gallery','staff','logo'));
