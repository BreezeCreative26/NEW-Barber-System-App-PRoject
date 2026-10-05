-- Prefunded Foliyo wallets. No historical money is credited automatically by this migration.
-- Activation requires server-side release gates plus explicit platform/shop eligibility.
CREATE TABLE wallet_funding_policy (
  id INTEGER PRIMARY KEY CHECK(id=1),
  accelerated_enabled INTEGER NOT NULL DEFAULT 0 CHECK(accelerated_enabled IN (0,1)),
  safety_buffer_pence BIGINT NOT NULL DEFAULT 200000 CHECK(safety_buffer_pence>=0),
  updated_at BIGINT NOT NULL DEFAULT 0
);
INSERT INTO wallet_funding_policy(id) VALUES(1);
ALTER TABLE shops ADD COLUMN wallet_accelerated_enabled INTEGER NOT NULL DEFAULT 0 CHECK(wallet_accelerated_enabled IN (0,1));
ALTER TABLE shops ADD COLUMN wallet_advance_limit_pence BIGINT NOT NULL DEFAULT 0 CHECK(wallet_advance_limit_pence>=0);

CREATE TABLE wallet_receipts (
  payment_intent TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross_pence BIGINT NOT NULL CHECK(gross_pence>0),
  fee_pence BIGINT NOT NULL CHECK(fee_pence>=0 AND fee_pence<=gross_pence),
  net_pence BIGINT GENERATED ALWAYS AS (gross_pence-fee_pence) STORED,
  funded_pence BIGINT NOT NULL DEFAULT 0,
  transferred_pence BIGINT NOT NULL DEFAULT 0,
  source_settled_at BIGINT,
  checked_at BIGINT NOT NULL DEFAULT 0,
  blocked_reason TEXT NOT NULL DEFAULT 'Awaiting funding checks',
  created_at BIGINT NOT NULL,
  FOREIGN KEY(shop_id,booking_id) REFERENCES bookings(shop_id,id),
  CHECK(funded_pence=0 OR funded_pence=gross_pence-fee_pence),
  CHECK(transferred_pence>=0 AND transferred_pence<=funded_pence)
);
CREATE INDEX wallet_receipts_shop ON wallet_receipts(shop_id,created_at);
CREATE TABLE wallet_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_intent TEXT NOT NULL REFERENCES wallet_receipts(payment_intent),
  from_bucket TEXT NOT NULL,
  to_bucket TEXT NOT NULL,
  amount_pence BIGINT NOT NULL CHECK(amount_pence>0),
  created_at BIGINT NOT NULL,
  CHECK(from_bucket<>to_bucket)
);
CREATE TABLE wallet_risks (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  payment_intent TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
  updated_at BIGINT NOT NULL
);
CREATE INDEX wallet_risks_open ON wallet_risks(shop_id) WHERE resolved=0;

ALTER TABLE pay_runs ADD COLUMN payment_ids_json TEXT;
CREATE TABLE pay_run_payments (
  pay_run_id TEXT NOT NULL REFERENCES pay_runs(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  PRIMARY KEY(pay_run_id,payment_id)
);
CREATE TABLE wallet_run_allocations (
  payment_intent TEXT PRIMARY KEY REFERENCES wallet_receipts(payment_intent),
  pay_run_id TEXT NOT NULL REFERENCES pay_runs(id),
  amount_pence BIGINT NOT NULL CHECK(amount_pence>=0),
  created_at BIGINT NOT NULL
);
CREATE TABLE wallet_transfer_operations (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  pay_run_id TEXT NOT NULL REFERENCES pay_runs(id),
  owner_type TEXT NOT NULL CHECK(owner_type IN ('SHOP','STAFF')),
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connected_accounts(id),
  amount_pence BIGINT NOT NULL CHECK(amount_pence>0),
  currency TEXT NOT NULL CHECK(currency='GBP'),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','UNKNOWN','SUCCEEDED')),
  stripe_id TEXT UNIQUE,
  started_at BIGINT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  UNIQUE(pay_run_id,owner_type),
  CHECK((status='SUCCEEDED')=(stripe_id IS NOT NULL))
);
CREATE TABLE wallet_transfer_sources (
  operation_id TEXT NOT NULL REFERENCES wallet_transfer_operations(id),
  payment_intent TEXT NOT NULL REFERENCES wallet_receipts(payment_intent),
  amount_pence BIGINT NOT NULL CHECK(amount_pence>0),
  PRIMARY KEY(operation_id,payment_intent)
);

CREATE FUNCTION wallet_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'wallet_history_immutable'; END $$;
CREATE TRIGGER wallet_movements_immutable BEFORE UPDATE OR DELETE ON wallet_movements FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
CREATE TRIGGER wallet_allocations_immutable BEFORE UPDATE OR DELETE ON wallet_run_allocations FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
CREATE TRIGGER wallet_sources_immutable BEFORE UPDATE OR DELETE ON wallet_transfer_sources FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
CREATE TRIGGER wallet_snapshots_immutable BEFORE UPDATE OR DELETE ON pay_run_payments FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
CREATE FUNCTION wallet_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'wallet_history_immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.payment_intent,NEW.shop_id,NEW.booking_id,NEW.currency,NEW.gross_pence,NEW.fee_pence,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.payment_intent,OLD.shop_id,OLD.booking_id,OLD.currency,OLD.gross_pence,OLD.fee_pence,OLD.created_at)
       OR NEW.funded_pence<OLD.funded_pence OR NEW.transferred_pence<OLD.transferred_pence THEN
      RAISE EXCEPTION 'wallet_receipt_immutable';
    END IF;
    IF NEW.funded_pence>OLD.funded_pence THEN
      INSERT INTO wallet_movements(payment_intent,from_bucket,to_bucket,amount_pence,created_at)
        VALUES(NEW.payment_intent,'PENDING','BACKED',NEW.funded_pence-OLD.funded_pence,(EXTRACT(EPOCH FROM now())*1000)::bigint);
    END IF;
    IF NEW.transferred_pence>OLD.transferred_pence THEN
      INSERT INTO wallet_movements(payment_intent,from_bucket,to_bucket,amount_pence,created_at)
        VALUES(NEW.payment_intent,'BACKED','TRANSFERRED',NEW.transferred_pence-OLD.transferred_pence,(EXTRACT(EPOCH FROM now())*1000)::bigint);
    END IF;
  ELSE
    INSERT INTO wallet_movements(payment_intent,from_bucket,to_bucket,amount_pence,created_at)
      SELECT NEW.payment_intent,'COLLECTED','PENDING',NEW.gross_pence-NEW.fee_pence,NEW.created_at WHERE NEW.gross_pence>NEW.fee_pence;
  END IF;
  RETURN NEW;
END $$;
-- AFTER INSERT makes the FK in the journal valid; BEFORE UPDATE protects economic identity.
CREATE TRIGGER wallet_receipt_insert AFTER INSERT ON wallet_receipts FOR EACH ROW EXECUTE FUNCTION wallet_receipt_guard();
CREATE TRIGGER wallet_receipt_update BEFORE UPDATE OR DELETE ON wallet_receipts FOR EACH ROW EXECUTE FUNCTION wallet_receipt_guard();

CREATE FUNCTION wallet_record_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cur TEXT; prior wallet_receipts; gross BIGINT; fee BIGINT;
BEGIN
  IF NEW.stripe_payment_intent='' OR NEW.method NOT IN ('CARD','ONLINE') THEN RETURN NEW; END IF;
  SELECT currency INTO cur FROM shops WHERE id=NEW.shop_id;
  gross:=NEW.service_pence+NEW.tip_pence; fee:=LEAST(gross,NEW.platform_fee_pence);
  INSERT INTO wallet_receipts(payment_intent,shop_id,booking_id,currency,gross_pence,fee_pence,created_at)
    VALUES(NEW.stripe_payment_intent,NEW.shop_id,NEW.booking_id,cur,gross,fee,NEW.created_at) ON CONFLICT DO NOTHING;
  SELECT * INTO prior FROM wallet_receipts WHERE payment_intent=NEW.stripe_payment_intent;
  IF prior.shop_id<>NEW.shop_id OR prior.booking_id<>NEW.booking_id OR prior.gross_pence<>gross OR prior.fee_pence<>fee THEN
    RAISE EXCEPTION 'wallet_payment_identity_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_payment_received AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION wallet_record_payment();
CREATE FUNCTION wallet_record_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cur TEXT; fee BIGINT;
BEGIN
  IF NEW.deposit_status='PAID' AND OLD.deposit_status IS DISTINCT FROM NEW.deposit_status AND NEW.stripe_payment_intent<>'' AND NEW.deposit_paid_pence>0 THEN
    SELECT currency INTO cur FROM shops WHERE id=NEW.shop_id;
    SELECT LEAST(NEW.deposit_paid_pence,round(NEW.deposit_paid_pence*fee_bps/10000.0)+fee_fixed_pence) INTO fee FROM platform_payments WHERE id=1;
    INSERT INTO wallet_receipts(payment_intent,shop_id,booking_id,currency,gross_pence,fee_pence,created_at)
      VALUES(NEW.stripe_payment_intent,NEW.shop_id,NEW.id,cur,NEW.deposit_paid_pence,COALESCE(fee,0),NEW.updated_at) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_deposit_received AFTER UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION wallet_record_deposit();

CREATE FUNCTION wallet_snapshot_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid TEXT; p payments; service BIGINT:=0; tips BIGINT:=0; card_service BIGINT:=0; card_tips BIGINT:=0;
BEGIN
  IF NEW.payment_ids_json IS NULL THEN RETURN NEW; END IF; -- legacy runs require reconciliation, not inferred allocations
  FOR pid IN SELECT jsonb_array_elements_text(NEW.payment_ids_json::jsonb) LOOP
    SELECT * INTO p FROM payments WHERE id=pid FOR UPDATE;
    IF NOT FOUND OR p.shop_id<>NEW.shop_id OR p.staff_id<>NEW.staff_id OR p.date NOT BETWEEN NEW.period_from AND NEW.period_to OR p.voided_at IS NOT NULL OR p.pay_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'wallet_stale_payment_snapshot';
    END IF;
    INSERT INTO pay_run_payments VALUES(NEW.id,p.id);
    UPDATE payments SET pay_run_id=NEW.id WHERE id=p.id;
    service:=service+p.service_pence; tips:=tips+p.tip_pence;
    IF p.method='ONLINE' OR (p.method='CARD' AND p.stripe_payment_intent<>'') THEN
      card_service:=card_service+p.service_pence; card_tips:=card_tips+p.tip_pence;
    END IF;
  END LOOP;
  IF service<>NEW.service_pence OR tips<>NEW.tips_pence OR card_service<>NEW.card_service_pence OR card_tips<>NEW.card_tips_pence THEN
    RAISE EXCEPTION 'wallet_stale_payment_snapshot';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_run_snapshot AFTER INSERT ON pay_runs FOR EACH ROW EXECUTE FUNCTION wallet_snapshot_run();
CREATE FUNCTION wallet_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_ids_json IS DISTINCT FROM OLD.payment_ids_json THEN RAISE EXCEPTION 'wallet_snapshot_immutable'; END IF;
  IF NEW.status='VOID' AND OLD.status<>'VOID' THEN
    IF EXISTS(SELECT 1 FROM wallet_run_allocations WHERE pay_run_id=OLD.id) OR EXISTS(SELECT 1 FROM transfers WHERE pay_run_id=OLD.id) THEN
      RAISE EXCEPTION 'wallet_allocated_run_cannot_void';
    END IF;
    UPDATE payments SET pay_run_id=NULL WHERE pay_run_id=OLD.id;
  END IF;
  IF NEW.status='PAID' AND OLD.status NOT IN ('TRANSFERRED','PAID') AND NEW.card_service_pence+NEW.card_tips_pence>0 THEN
    RAISE EXCEPTION 'wallet_card_run_requires_transfer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_run_protect BEFORE UPDATE ON pay_runs FOR EACH ROW EXECUTE FUNCTION wallet_run_guard();
CREATE FUNCTION wallet_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'wallet_history_immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','stripe_id','started_at','last_error']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','stripe_id','started_at','last_error'])
    OR (OLD.status='SUCCEEDED' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
    RAISE EXCEPTION 'wallet_operation_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_operation_protect BEFORE UPDATE OR DELETE ON wallet_transfer_operations FOR EACH ROW EXECUTE FUNCTION wallet_operation_guard();

-- These are server-only ledgers. Do not expose through the Supabase Data API.
DO $$ DECLARE t TEXT; r TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['wallet_funding_policy','wallet_receipts','wallet_movements','wallet_risks','pay_run_payments','wallet_run_allocations','wallet_transfer_operations','wallet_transfer_sources'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
    END LOOP;
  END LOOP;
END $$;
