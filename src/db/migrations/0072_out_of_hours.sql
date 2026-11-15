-- Out-of-hours slots: a barber opens time outside their normal hours (or on a day off). Customers
-- see it online (orange) and pay the barber's out-of-hours charge, which sits on the booking as an
-- 'OOH' item. Default charge £5.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS ooh_fee_pence INTEGER NOT NULL DEFAULT 500 CHECK (ooh_fee_pence BETWEEN 0 AND 100000);
CREATE TABLE IF NOT EXISTS staff_ooh (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, staff_id TEXT NOT NULL, date TEXT NOT NULL,
  starts INTEGER NOT NULL CHECK (starts BETWEEN 0 AND 1439),
  ends INTEGER NOT NULL CHECK (ends BETWEEN 1 AND 1440 AND ends > starts),
  note TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL,
  UNIQUE (shop_id, staff_id, date),
  FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id)
);
CREATE OR REPLACE FUNCTION ollo_booking_slot_checks(b bookings) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ooh boolean;
BEGIN
  -- Out-of-hours time the barber opened covers this booking: hours, day off and closures don't apply.
  ooh := EXISTS (SELECT 1 FROM staff_ooh w WHERE w.shop_id=b.shop_id AND w.staff_id=b.staff_id AND w.date=b.date
    AND b.start_min >= w.starts AND b.start_min + b.duration_min + b.buffer_min <= w.ends);
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id=b.staff_id AND shop_id=b.shop_id AND active=1) THEN PERFORM ollo_abort('barber_unavailable'); END IF;
  IF NOT EXISTS (SELECT 1 FROM staff_service_rules r WHERE r.shop_id=b.shop_id AND r.staff_id=b.staff_id AND r.service_id=b.service_id AND r.enabled=1) THEN PERFORM ollo_abort('service_ineligible'); END IF;
  IF NOT ollo_force_slot() AND NOT ooh AND EXISTS (SELECT 1 FROM holidays WHERE shop_id=b.shop_id AND date=b.date) THEN PERFORM ollo_abort('shop_closed'); END IF;
  IF NOT ollo_force_slot() AND NOT ooh AND EXISTS (SELECT 1 FROM staff_days_off d WHERE d.shop_id=b.shop_id AND d.staff_id=b.staff_id AND d.date=b.date) THEN PERFORM ollo_abort('staff_day_off'); END IF;
  IF NOT ollo_force_slot() AND NOT ooh AND NOT EXISTS (
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

CREATE OR REPLACE FUNCTION ollo_validate_booking_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE items jsonb; first jsonb;
BEGIN
  BEGIN items := NEW.items_json::jsonb; EXCEPTION WHEN others THEN PERFORM ollo_abort('invalid_booking_items'); END;
  IF jsonb_typeof(items)<>'array' OR jsonb_array_length(items) NOT BETWEEN 1 AND 12 THEN PERFORM ollo_abort('invalid_booking_items'); END IF;
  first := items->0;
  IF first->>'kind' IS DISTINCT FROM 'SERVICE' OR first->>'id' IS DISTINCT FROM NEW.service_id
     OR NEW.price_pence IS DISTINCT FROM (SELECT SUM((v->>'price_pence')::int) FROM jsonb_array_elements(items) v)
     OR COALESCE(NEW.customer_duration_min, NEW.duration_min) IS DISTINCT FROM (SELECT SUM((v->>'duration_min')::int) FROM jsonb_array_elements(items) v)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(items) v WHERE jsonb_typeof(v->'price_pence')<>'number' OR jsonb_typeof(v->'duration_min')<>'number')
     OR (SELECT COUNT(*) FROM jsonb_array_elements(items)) <> (SELECT COUNT(DISTINCT v->>'id') FROM jsonb_array_elements(items) v) THEN
    PERFORM ollo_abort('invalid_booking_items');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM services s LEFT JOIN staff_service_rules r ON r.shop_id=s.shop_id AND r.service_id=s.id AND r.staff_id=NEW.staff_id
    WHERE s.shop_id=NEW.shop_id AND s.id=NEW.service_id AND s.active=1
      AND s.name=NEW.service_name AND s.name=first->>'name'
      AND COALESCE(r.price_pence,s.price_pence)=(first->>'price_pence')::int
      AND COALESCE(r.duration_min,s.duration_min)=(first->>'duration_min')::int
  ) THEN PERFORM ollo_abort('service_changed'); END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(items) WITH ORDINALITY j(v, i) WHERE i>1 AND v->>'kind' IS DISTINCT FROM 'OOH' AND (
      v->>'kind' IS DISTINCT FROM 'ADDON' OR NOT EXISTS (
        SELECT 1 FROM addons a JOIN addon_services l ON l.shop_id=a.shop_id AND l.addon_id=a.id
        WHERE a.shop_id=NEW.shop_id AND a.id=v->>'id' AND a.active=1 AND l.service_id=NEW.service_id
          AND a.name=v->>'name' AND a.price_pence=(v->>'price_pence')::int AND a.duration_min=(v->>'duration_min')::int))
  ) THEN PERFORM ollo_abort('addon_unavailable'); END IF;
  -- Out-of-hours charge: the barber's current fee, no time, inside a window they opened.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(items) WITH ORDINALITY j(v, i) WHERE i>1 AND v->>'kind'='OOH' AND (
      (v->>'duration_min')::int <> 0
      OR (v->>'price_pence')::int IS DISTINCT FROM (SELECT ooh_fee_pence FROM staff WHERE id=NEW.staff_id AND shop_id=NEW.shop_id)
      OR NOT EXISTS (SELECT 1 FROM staff_ooh w WHERE w.shop_id=NEW.shop_id AND w.staff_id=NEW.staff_id AND w.date=NEW.date AND NEW.start_min >= w.starts AND NEW.start_min < w.ends))
  ) THEN PERFORM ollo_abort('ooh_changed'); END IF;
  IF NOT EXISTS (SELECT 1 FROM services WHERE id=NEW.service_id AND shop_id=NEW.shop_id AND version=NEW.quoted_service_version) THEN PERFORM ollo_abort('quote_changed'); END IF;
  IF NOT EXISTS (SELECT 1 FROM shops sh JOIN services sv ON sv.id=NEW.service_id AND sv.shop_id=sh.id
                 WHERE sh.id=NEW.shop_id AND sh.version=NEW.quoted_shop_version
                   AND ollo_due_at_booking(sh.payment_mode, sv.payment_mode, sh.deposit_pence, NEW.price_pence)=NEW.deposit_policy_pence
                   AND COALESCE(sv.payment_mode, sh.payment_mode)=NEW.payment_mode
                   AND sh.cancel_hours=NEW.cancel_hours_snapshot) THEN PERFORM ollo_abort('quote_changed'); END IF;
  PERFORM ollo_booking_slot_checks(NEW);
  RETURN NEW;
END $$;
