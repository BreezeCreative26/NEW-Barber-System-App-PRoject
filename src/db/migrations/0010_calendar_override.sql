-- Fresha-style calendar overrides. The shop may knowingly double-book a barber or book outside the
-- roster; customers never can. The app sets a transaction-local flag before the write; the trigger
-- keeps every other check (active barber, closed shop, day off, service eligibility) unconditional.
--   SELECT set_config('ollo.force_slot', '1', true);   -- true = local to the current transaction
CREATE OR REPLACE FUNCTION ollo_force_slot() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('ollo.force_slot', true), '') = '1' $$;

CREATE OR REPLACE FUNCTION ollo_booking_slot_checks(b bookings) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id=b.staff_id AND shop_id=b.shop_id AND active=1) THEN PERFORM ollo_abort('barber_unavailable'); END IF;
  IF EXISTS (SELECT 1 FROM staff_service_rules r WHERE r.shop_id=b.shop_id AND r.staff_id=b.staff_id AND r.service_id=b.service_id AND r.enabled=0) THEN PERFORM ollo_abort('service_ineligible'); END IF;
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
  -- Even when forced, the shop must be open that weekday: forcing covers the barber's roster, not the shop's.
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

-- Status changes into a live state re-check overlap; a deliberately double-booked visit must still
-- be allowed to check in and complete, so that path honours the same flag.
CREATE OR REPLACE FUNCTION ollo_validate_booking_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.staff_id<>OLD.staff_id OR NEW.date<>OLD.date OR NEW.start_at<>OLD.start_at OR NEW.end_at<>OLD.end_at OR NEW.status<>OLD.status THEN
    IF NEW.staff_id<>OLD.staff_id OR NEW.date<>OLD.date OR NEW.start_at<>OLD.start_at OR NEW.end_at<>OLD.end_at THEN
      PERFORM ollo_booking_slot_checks(NEW);
    ELSIF NEW.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED') AND OLD.status NOT IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED') AND NOT ollo_force_slot() AND EXISTS (
      SELECT 1 FROM bookings x WHERE x.shop_id=NEW.shop_id AND x.staff_id=NEW.staff_id AND x.id<>NEW.id
        AND x.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')
        AND x.start_at < NEW.end_at + NEW.buffer_min * 60000 AND NEW.start_at < x.end_at + x.buffer_min * 60000
    ) THEN PERFORM ollo_abort('slot_taken'); END IF;
  END IF;
  RETURN NEW;
END $$;
