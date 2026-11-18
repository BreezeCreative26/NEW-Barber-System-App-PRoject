-- Out-of-hours price per block: each time a barber opens out-of-hours time they set the charge for
-- that block. NULL = the barber's default out-of-hours charge (older blocks keep working as before).
ALTER TABLE staff_ooh ADD COLUMN IF NOT EXISTS fee_pence INTEGER CHECK (fee_pence BETWEEN 0 AND 100000);

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
  -- Out-of-hours charge: no time, inside a window they opened, at that block's price (or the barber's default).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(items) WITH ORDINALITY j(v, i) WHERE i>1 AND v->>'kind'='OOH' AND (
      (v->>'duration_min')::int <> 0
      OR NOT EXISTS (SELECT 1 FROM staff_ooh w JOIN staff st ON st.id=w.staff_id AND st.shop_id=w.shop_id
                     WHERE w.shop_id=NEW.shop_id AND w.staff_id=NEW.staff_id AND w.date=NEW.date AND NEW.start_min >= w.starts AND NEW.start_min < w.ends
                       AND (v->>'price_pence')::int = COALESCE(w.fee_pence, st.ooh_fee_pence)))
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

