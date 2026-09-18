-- Edit an appointment in place: service, add-ons, price and duration. The items snapshot is still
-- immutable by default; the app sets a transaction-local flag for the one UPDATE that rewrites it,
-- so nothing else (payments, pay runs, sweeps) can ever drift a snapshot by accident.
--   SELECT set_config('ollo.edit_items', '1', true);
CREATE OR REPLACE FUNCTION ollo_edit_items() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('ollo.edit_items', true), '') = '1' $$;

CREATE OR REPLACE FUNCTION ollo_booking_snapshots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.shop_id<>OLD.shop_id OR NEW.sequence<>OLD.sequence OR NEW.request_id<>OLD.request_id
     OR NEW.request_hash<>OLD.request_hash OR NEW.buffer_min<>OLD.buffer_min
     OR NEW.deposit_policy_pence<>OLD.deposit_policy_pence OR NEW.cancel_hours_snapshot<>OLD.cancel_hours_snapshot
     OR NEW.source<>OLD.source OR NEW.created_at<>OLD.created_at
     OR NEW.quoted_service_version IS DISTINCT FROM OLD.quoted_service_version OR NEW.quoted_shop_version IS DISTINCT FROM OLD.quoted_shop_version
     OR NEW.channel<>OLD.channel OR NEW.series_id IS DISTINCT FROM OLD.series_id THEN
    PERFORM ollo_abort('booking_snapshot_immutable');
  END IF;
  IF NOT ollo_edit_items() AND (NEW.service_id<>OLD.service_id OR NEW.service_name<>OLD.service_name
     OR NEW.price_pence<>OLD.price_pence OR NEW.duration_min<>OLD.duration_min OR NEW.items_json<>OLD.items_json) THEN
    PERFORM ollo_abort('booking_snapshot_immutable');
  END IF;
  IF OLD.group_id IS NOT NULL AND NEW.group_id IS DISTINCT FROM OLD.group_id THEN PERFORM ollo_abort('booking_group_immutable'); END IF;
  RETURN NEW;
END $$;

-- Money the shop owes back to a customer because the visit was re-priced below a deposit already
-- taken. Refunded to the card immediately; recovered from the barber's next pay run as a
-- negative adjustment (owner decision, 17 Sept 2026). pay_run_id is set when a run absorbs it.
CREATE TABLE IF NOT EXISTS booking_adjustments (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  kind TEXT NOT NULL CHECK (kind IN ('DEPOSIT_REFUND')),
  pence INTEGER NOT NULL,            -- negative = charged to the barber
  label TEXT NOT NULL,
  date TEXT NOT NULL,                -- visit date; drives which pay-run period absorbs it
  stripe_refund_id TEXT NOT NULL DEFAULT '',
  pay_run_id TEXT REFERENCES pay_runs(id),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_adjustments_open ON booking_adjustments(shop_id, staff_id, date) WHERE pay_run_id IS NULL;

-- Which line items were re-priced by hand (reporting). NULL = catalogue price at the time.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS items_edited_at BIGINT;
