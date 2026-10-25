-- One-off: The Doghouse signed up with the address "the-doghouse", then moved it to "tdh" on the
-- go-live step. The address is now fixed after signup, so this puts that one shop on the address
-- its owner wants, without wiping anything: thedoghouse.foliyo.co.uk.
-- Safe by construction: it only touches that exact shop, only while it is still on "tdh", and does
-- nothing if "thedoghouse" is already taken. On every other database (dev, tests, fresh installs)
-- no row matches, so it changes nothing. Re-running it is a no-op.
UPDATE shops
   SET slug = 'thedoghouse', version = version + 1
 WHERE id = '4735f455-0ad2-410e-bb44-0d06315e7a81'
   AND slug = 'tdh'
   AND NOT EXISTS (SELECT 1 FROM shops o WHERE o.slug = 'thedoghouse');

INSERT INTO audit_events (id, shop_id, entity_type, entity_id, action, actor, reason, created_at)
SELECT gen_random_uuid()::text, s.id, 'shop', s.id, 'SLUG_CHANGED', 'platform:migration',
       'Web address set to thedoghouse (was tdh) at the owner''s request.',
       (extract(epoch from now()) * 1000)::bigint
  FROM shops s
 WHERE s.id = '4735f455-0ad2-410e-bb44-0d06315e7a81'
   AND s.slug = 'thedoghouse'
   AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.shop_id = s.id AND a.action = 'SLUG_CHANGED' AND a.actor = 'platform:migration');
