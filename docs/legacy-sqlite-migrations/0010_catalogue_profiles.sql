-- Service studio and barber profiles: presentation and ordering fields only.
-- Pricing/duration/eligibility guards are unchanged; snapshots stay immutable.
ALTER TABLE services ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN colour TEXT NOT NULL DEFAULT 'sage' CHECK(colour IN ('sage','sand','blue','clay','plum','slate'));
ALTER TABLE services ADD COLUMN online_bookable INTEGER NOT NULL DEFAULT 1 CHECK(online_bookable IN (0,1));
ALTER TABLE services ADD COLUMN popular INTEGER NOT NULL DEFAULT 0 CHECK(popular IN (0,1));
ALTER TABLE services ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE staff ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE staff ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE staff ADD COLUMN colour TEXT NOT NULL DEFAULT 'sage' CHECK(colour IN ('sage','sand','blue','clay','plum','slate'));
ALTER TABLE staff ADD COLUMN photo_url TEXT NOT NULL DEFAULT '';
ALTER TABLE staff ADD COLUMN online_visible INTEGER NOT NULL DEFAULT 1 CHECK(online_visible IN (0,1));
ALTER TABLE staff ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE staff ADD COLUMN instagram TEXT NOT NULL DEFAULT '';
ALTER TABLE staff ADD COLUMN start_date TEXT;
ALTER TABLE staff ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Spread existing rows across the palette so cards are distinguishable immediately.
UPDATE staff SET colour = CASE ((SELECT COUNT(*) FROM staff s2 WHERE s2.shop_id=staff.shop_id AND s2.rowid < staff.rowid) % 4)
  WHEN 0 THEN 'sage' WHEN 1 THEN 'sand' WHEN 2 THEN 'blue' ELSE 'clay' END;
UPDATE services SET colour = CASE ((SELECT COUNT(*) FROM services s2 WHERE s2.shop_id=services.shop_id AND s2.rowid < services.rowid) % 4)
  WHEN 0 THEN 'sage' WHEN 1 THEN 'blue' WHEN 2 THEN 'sand' ELSE 'clay' END;
