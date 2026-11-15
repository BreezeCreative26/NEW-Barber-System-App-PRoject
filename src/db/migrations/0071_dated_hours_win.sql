-- Dated (calendar-changed) hours are what the barber works that day, even outside the shop's usual
-- opening hours. Weekly hours stay inside opening hours as before.
CREATE OR REPLACE FUNCTION ollo_booking_slot_checks(b bookings) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id=b.staff_id AND shop_id=b.shop_id AND active=1) THEN PERFORM ollo_abort('barber_unavailable'); END IF;
  IF NOT EXISTS (SELECT 1 FROM staff_service_rules r WHERE r.shop_id=b.shop_id AND r.staff_id=b.staff_id AND r.service_id=b.service_id AND r.enabled=1) THEN PERFORM ollo_abort('service_ineligible'); END IF;
  IF NOT ollo_force_slot() AND EXISTS (SELECT 1 FROM holidays WHERE shop_id=b.shop_id AND date=b.date) THEN PERFORM ollo_abort('shop_closed'); END IF;
  IF NOT ollo_force_slot() AND EXISTS (SELECT 1 FROM staff_days_off d WHERE d.shop_id=b.shop_id AND d.staff_id=b.staff_id AND d.date=b.date) THEN PERFORM ollo_abort('staff_day_off'); END IF;
  IF NOT ollo_force_slot() AND NOT EXISTS (
    SELECT 1 FROM staff_hours h JOIN shops s ON s.id=h.shop_id
    LEFT JOIN staff_schedule_overrides o ON o.shop_id=h.shop_id AND o.staff_id=h.staff_id AND o.date=b.date
    WHERE h.shop_id=b.shop_id AND h.staff_id=b.staff_id AND h.weekday=ollo_weekday(b.date)
      AND COALESCE(o.enabled,h.enabled)=1
      AND b.start_min >= CASE WHEN o.id IS NOT NULL THEN o.starts ELSE GREATEST(h.starts, s.opens, ((s.week_json::jsonb)->h.weekday->>'starts')::int) END
      AND b.start_min + b.duration_min + b.buffer_min <= CASE WHEN o.id IS NOT NULL THEN o.ends ELSE LEAST(h.ends, s.closes, ((s.week_json::jsonb)->h.weekday->>'ends')::int) END
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
  IF NOT ollo_force_slot() AND b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED') AND EXISTS (
    SELECT 1 FROM bookings x WHERE x.shop_id=b.shop_id AND x.staff_id=b.staff_id AND x.id<>b.id
      AND x.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')
      AND x.start_at < b.end_at + b.buffer_min * 60000
      AND b.start_at < x.end_at + x.buffer_min * 60000
  ) THEN PERFORM ollo_abort('slot_taken'); END IF;
END $$;
