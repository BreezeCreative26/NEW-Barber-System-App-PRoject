-- 1) WhatsApp is retired (WHATSAPP_RETIRED in messaging.ts: nothing is ever sent on it), but the
--    per-shop switch defaulted to ON and showed as on in settings. Switch it off everywhere and make
--    new shops start with it off, so settings never claim a channel that does not exist.
UPDATE shops SET msg_wa = 0 WHERE msg_wa <> 0;
ALTER TABLE shops ALTER COLUMN msg_wa SET DEFAULT 0;

-- 2) The Doghouse signed up as a "shop login" (role SHOP: a free login that can only invite the real
--    owner) but it is the owner. Make that one login the owner, so owner-only settings (billing,
--    custom domain, team) are available to them. Only that shop, only while it has the shop login
--    and no owner yet; a no-op on every other database and when re-run.
UPDATE app_memberships
   SET role = 'OWNER', version = version + 1
 WHERE shop_id = '4735f455-0ad2-410e-bb44-0d06315e7a81'
   AND role = 'SHOP'
   AND active = 1
   AND NOT EXISTS (SELECT 1 FROM app_memberships o WHERE o.shop_id = '4735f455-0ad2-410e-bb44-0d06315e7a81' AND o.role = 'OWNER');
