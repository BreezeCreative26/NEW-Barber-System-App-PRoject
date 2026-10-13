CREATE TABLE addons (
 id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id), name TEXT NOT NULL,
 duration_min INTEGER NOT NULL CHECK(duration_min BETWEEN 0 AND 120),
 price_pence INTEGER NOT NULL CHECK(price_pence BETWEEN 0 AND 100000),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), version INTEGER NOT NULL DEFAULT 0,
 UNIQUE(shop_id,id)
);
CREATE TABLE addon_services (
 shop_id TEXT NOT NULL, addon_id TEXT NOT NULL, service_id TEXT NOT NULL,
 PRIMARY KEY(shop_id,addon_id,service_id),
 FOREIGN KEY(shop_id,addon_id) REFERENCES addons(shop_id,id),
 FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
CREATE TABLE staff_service_rules (
 shop_id TEXT NOT NULL, staff_id TEXT NOT NULL, service_id TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 price_pence INTEGER CHECK(price_pence BETWEEN 0 AND 100000),
 duration_min INTEGER CHECK(duration_min BETWEEN 5 AND 240),
 version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(shop_id,staff_id,service_id),
 FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id),
 FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
CREATE TABLE staff_schedule_overrides (
 id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, staff_id TEXT NOT NULL, date TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), starts INTEGER NOT NULL CHECK(starts BETWEEN 0 AND 1439),
 ends INTEGER NOT NULL CHECK(ends BETWEEN 1 AND 1440 AND ends>starts),
 break_start INTEGER NOT NULL CHECK(break_start>=starts),
 break_end INTEGER NOT NULL CHECK(break_end>=break_start AND break_end<=ends),
 reason TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
 UNIQUE(shop_id,staff_id,date),
 FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
ALTER TABLE bookings ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(items_json));
-- Existing bookings predate add-ons: preserve them as one immutable service line.
UPDATE bookings SET items_json=json_array(json_object('kind','SERVICE','id',service_id,'name',service_name,'price_pence',price_pence,'duration_min',duration_min));
CREATE TRIGGER immutable_booking_items BEFORE UPDATE OF items_json ON bookings
BEGIN SELECT RAISE(ABORT,'booking_snapshot_immutable'); END;

DROP TRIGGER validate_booking_insert;
DROP TRIGGER validate_booking_reschedule;

-- Item snapshots are inserted in the SAME booking row/write as the interval lock.
CREATE TRIGGER validate_booking_items BEFORE INSERT ON bookings
BEGIN
 SELECT RAISE(ABORT,'invalid_booking_items') WHERE json_type(NEW.items_json)<>'array'
   OR json_array_length(NEW.items_json) NOT BETWEEN 1 AND 11
   OR json_extract(NEW.items_json,'$[0].kind') IS NOT 'SERVICE'
   OR json_extract(NEW.items_json,'$[0].id') IS NOT NEW.service_id
   OR NEW.price_pence IS NOT (SELECT SUM(json_extract(value,'$.price_pence')) FROM json_each(NEW.items_json))
   OR NEW.duration_min IS NOT (SELECT SUM(json_extract(value,'$.duration_min')) FROM json_each(NEW.items_json))
   OR EXISTS(SELECT 1 FROM json_each(NEW.items_json) WHERE json_type(value,'$.price_pence') IS NOT 'integer' OR json_type(value,'$.duration_min') IS NOT 'integer')
   OR (SELECT COUNT(*) FROM json_each(NEW.items_json)) <> (SELECT COUNT(DISTINCT json_extract(value,'$.id')) FROM json_each(NEW.items_json));
 SELECT RAISE(ABORT,'service_ineligible') WHERE EXISTS(SELECT 1 FROM staff_service_rules r WHERE r.shop_id=NEW.shop_id AND r.staff_id=NEW.staff_id AND r.service_id=NEW.service_id AND r.enabled=0);
 SELECT RAISE(ABORT,'service_changed') WHERE NOT EXISTS (
   SELECT 1 FROM services s LEFT JOIN staff_service_rules r ON r.shop_id=s.shop_id AND r.service_id=s.id AND r.staff_id=NEW.staff_id
   WHERE s.shop_id=NEW.shop_id AND s.id=NEW.service_id AND s.active=1
   AND s.name=NEW.service_name AND s.name=json_extract(NEW.items_json,'$[0].name')
   AND COALESCE(r.price_pence,s.price_pence)=json_extract(NEW.items_json,'$[0].price_pence')
   AND COALESCE(r.duration_min,s.duration_min)=json_extract(NEW.items_json,'$[0].duration_min')
 );
 SELECT RAISE(ABORT,'addon_unavailable') WHERE EXISTS (
   SELECT 1 FROM json_each(NEW.items_json) j WHERE j.key>0 AND (
    json_extract(j.value,'$.kind') IS NOT 'ADDON' OR NOT EXISTS (
     SELECT 1 FROM addons a JOIN addon_services l ON l.shop_id=a.shop_id AND l.addon_id=a.id
     WHERE a.shop_id=NEW.shop_id AND a.id=json_extract(j.value,'$.id') AND a.active=1 AND l.service_id=NEW.service_id
     AND a.name=json_extract(j.value,'$.name') AND a.price_pence=json_extract(j.value,'$.price_pence') AND a.duration_min=json_extract(j.value,'$.duration_min')
    )
   )
 );
END;

CREATE TRIGGER validate_booking_insert BEFORE INSERT ON bookings
BEGIN
 SELECT RAISE(ABORT,'barber_unavailable') WHERE NOT EXISTS(SELECT 1 FROM staff WHERE id=NEW.staff_id AND shop_id=NEW.shop_id AND active=1);
 SELECT RAISE(ABORT,'shop_closed') WHERE EXISTS(SELECT 1 FROM holidays WHERE shop_id=NEW.shop_id AND date=NEW.date);
 SELECT RAISE(ABORT,'outside_hours') WHERE NOT EXISTS (
  SELECT 1 FROM staff_hours h JOIN shops s ON s.id=h.shop_id
  LEFT JOIN staff_schedule_overrides o ON o.shop_id=h.shop_id AND o.staff_id=h.staff_id AND o.date=NEW.date
  WHERE h.shop_id=NEW.shop_id AND h.staff_id=NEW.staff_id AND h.weekday=CAST(strftime('%w',NEW.date) AS INTEGER)
  AND COALESCE(o.enabled,h.enabled)=1
  AND NEW.start_min>=MAX(COALESCE(o.starts,h.starts),s.opens)
  AND NEW.start_min+NEW.duration_min+NEW.buffer_min<=MIN(COALESCE(o.ends,h.ends),s.closes)
  AND NOT (COALESCE(o.break_end,h.break_end)>COALESCE(o.break_start,h.break_start) AND NEW.start_min<COALESCE(o.break_end,h.break_end) AND NEW.start_min+NEW.duration_min+NEW.buffer_min>COALESCE(o.break_start,h.break_start))
  AND NOT EXISTS(SELECT 1 FROM json_each(s.closed_days) d WHERE d.value=h.weekday)
 );
END;
CREATE TRIGGER validate_booking_reschedule BEFORE UPDATE OF staff_id,date,start_at,end_at ON bookings
BEGIN
 SELECT RAISE(ABORT,'barber_unavailable') WHERE NOT EXISTS(SELECT 1 FROM staff WHERE id=NEW.staff_id AND shop_id=NEW.shop_id AND active=1);
 SELECT RAISE(ABORT,'service_ineligible') WHERE EXISTS(SELECT 1 FROM staff_service_rules r WHERE r.shop_id=NEW.shop_id AND r.staff_id=NEW.staff_id AND r.service_id=NEW.service_id AND r.enabled=0);
 SELECT RAISE(ABORT,'shop_closed') WHERE EXISTS(SELECT 1 FROM holidays WHERE shop_id=NEW.shop_id AND date=NEW.date);
 SELECT RAISE(ABORT,'outside_hours') WHERE NOT EXISTS (
  SELECT 1 FROM staff_hours h JOIN shops s ON s.id=h.shop_id
  LEFT JOIN staff_schedule_overrides o ON o.shop_id=h.shop_id AND o.staff_id=h.staff_id AND o.date=NEW.date
  WHERE h.shop_id=NEW.shop_id AND h.staff_id=NEW.staff_id AND h.weekday=CAST(strftime('%w',NEW.date) AS INTEGER)
  AND COALESCE(o.enabled,h.enabled)=1
  AND NEW.start_min>=MAX(COALESCE(o.starts,h.starts),s.opens)
  AND NEW.start_min+NEW.duration_min+NEW.buffer_min<=MIN(COALESCE(o.ends,h.ends),s.closes)
  AND NOT (COALESCE(o.break_end,h.break_end)>COALESCE(o.break_start,h.break_start) AND NEW.start_min<COALESCE(o.break_end,h.break_end) AND NEW.start_min+NEW.duration_min+NEW.buffer_min>COALESCE(o.break_start,h.break_start))
  AND NOT EXISTS(SELECT 1 FROM json_each(s.closed_days) d WHERE d.value=h.weekday)
 );
END;
