-- Barber hub rebuild.
--
-- 1) A barber now offers a service only when someone has ticked it ("off until ticked"). Until now a
--    missing staff_service_rules row meant "offered at the shop price". Keep every existing offering
--    exactly as it is by writing the explicit rows first, then flip the rule in the booking trigger.
INSERT INTO staff_service_rules(shop_id, staff_id, service_id, enabled)
SELECT st.shop_id, st.id, sv.id, 1
  FROM staff st
  JOIN services sv ON sv.shop_id = st.shop_id
 WHERE NOT EXISTS (SELECT 1 FROM staff_service_rules r WHERE r.shop_id = st.shop_id AND r.staff_id = st.id AND r.service_id = sv.id);

CREATE OR REPLACE FUNCTION ollo_booking_slot_checks(b bookings) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id=b.staff_id AND shop_id=b.shop_id AND active=1) THEN PERFORM ollo_abort('barber_unavailable'); END IF;
  IF NOT EXISTS (SELECT 1 FROM staff_service_rules r WHERE r.shop_id=b.shop_id AND r.staff_id=b.staff_id AND r.service_id=b.service_id AND r.enabled=1) THEN PERFORM ollo_abort('service_ineligible'); END IF;
  IF EXISTS (SELECT 1 FROM holidays WHERE shop_id=b.shop_id AND date=b.date) THEN PERFORM ollo_abort('shop_closed'); END IF;
  IF EXISTS (SELECT 1 FROM staff_days_off d WHERE d.shop_id=b.shop_id AND d.staff_id=b.staff_id AND d.date=b.date) THEN PERFORM ollo_abort('staff_day_off'); END IF;
  IF NOT ollo_force_slot() AND NOT EXISTS (
    SELECT 1 FROM staff_hours h JOIN shops s ON s.id=h.shop_id
    LEFT JOIN staff_schedule_overrides o ON o.shop_id=h.shop_id AND o.staff_id=h.staff_id AND o.date=b.date
    WHERE h.shop_id=b.shop_id AND h.staff_id=b.staff_id AND h.weekday=ollo_weekday(b.date)
      AND COALESCE(o.enabled,h.enabled)=1
      AND b.start_min >= GREATEST(COALESCE(o.starts,h.starts), s.opens, ((s.week_json::jsonb)->h.weekday->>'starts')::int)
      AND b.start_min + b.duration_min + b.buffer_min <= LEAST(COALESCE(o.ends,h.ends), s.closes, ((s.week_json::jsonb)->h.weekday->>'ends')::int)
      AND ((s.week_json::jsonb)->h.weekday->>'enabled')::int = 1
      AND NOT (COALESCE(o.break_end,h.break_end) > COALESCE(o.break_start,h.break_start)
               AND b.start_min < COALESCE(o.break_end,h.break_end)
               AND b.start_min + b.duration_min + b.buffer_min > COALESCE(o.break_start,h.break_start))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.closed_days::jsonb) d WHERE d::int = h.weekday)
  ) THEN PERFORM ollo_abort('outside_hours'); END IF;
  IF NOT ollo_force_slot() AND EXISTS (
    SELECT 1 FROM staff_blocks k WHERE k.shop_id=b.shop_id AND k.staff_id=b.staff_id AND k.date=b.date
      AND b.start_min < k.end_min AND b.start_min + b.duration_min + b.buffer_min > k.start_min
  ) THEN PERFORM ollo_abort('outside_hours'); END IF;
  IF ollo_force_slot() AND NOT EXISTS (
    SELECT 1 FROM shops s WHERE s.id=b.shop_id
      AND ((s.week_json::jsonb)->ollo_weekday(b.date)->>'enabled')::int = 1
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.closed_days::jsonb) d WHERE d::int = ollo_weekday(b.date))
  ) THEN PERFORM ollo_abort('shop_closed'); END IF;
  IF NOT ollo_force_slot() AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED') AND EXISTS (
    SELECT 1 FROM bookings x WHERE x.shop_id=b.shop_id AND x.staff_id=b.staff_id AND x.id<>b.id
      AND x.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')
      AND x.start_at < b.end_at + b.buffer_min * 60000
      AND b.start_at < x.end_at + x.buffer_min * 60000
  ) THEN PERFORM ollo_abort('slot_taken'); END IF;
END $$;

-- 2) Real service categories (name, order, description) instead of a free-text label on each service.
CREATE TABLE IF NOT EXISTS service_categories (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
  UNIQUE (shop_id, name)
);
INSERT INTO service_categories(id, shop_id, name, sort_order)
SELECT gen_random_uuid()::text, d.shop_id, d.category, (row_number() OVER (PARTITION BY d.shop_id ORDER BY d.first_sort, d.category) - 1)::int
  FROM (SELECT shop_id, category, MIN(sort_order) AS first_sort FROM services WHERE category <> '' GROUP BY shop_id, category) d
ON CONFLICT DO NOTHING;

-- 3) A barber can follow the shop's opening hours: when the shop changes them, the owner is offered
--    to apply the change to everyone who follows. Existing barbers keep their own hours (0).
ALTER TABLE staff ADD COLUMN IF NOT EXISTS follows_shop_hours INTEGER NOT NULL DEFAULT 0 CHECK (follows_shop_hours IN (0,1));
