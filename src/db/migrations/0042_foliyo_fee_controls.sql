-- Foliyo's advertised B2B fees, separate from private Stripe/provider costs.
CREATE TABLE foliyo_fee_rules (
  scope TEXT PRIMARY KEY,
  shop_id TEXT UNIQUE REFERENCES shops(id),
  fee_bps INTEGER NOT NULL CHECK(fee_bps BETWEEN 0 AND 2000),
  fixed_pence INTEGER NOT NULL CHECK(fixed_pence BETWEEN 0 AND 500),
  use_default INTEGER NOT NULL DEFAULT 0 CHECK(use_default IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL,
  CHECK((scope='default' AND shop_id IS NULL AND use_default=0) OR (shop_id IS NOT NULL AND scope=shop_id))
);
INSERT INTO foliyo_fee_rules(scope,fee_bps,fixed_pence,updated_at)
  SELECT 'default',fee_bps,fee_fixed_pence,updated_at FROM platform_payments WHERE id=1;
CREATE FUNCTION foliyo_effective_fee(sid TEXT) RETURNS TABLE(fee_bps INTEGER,fixed_pence INTEGER,rule_scope TEXT,rule_version INTEGER) LANGUAGE sql STABLE AS $$
  SELECT r.fee_bps,CASE WHEN (SELECT currency FROM shops WHERE id=sid)='GBP' THEN r.fixed_pence ELSE 0 END,r.scope,r.version FROM foliyo_fee_rules r
  WHERE r.scope='default' OR (r.shop_id=sid AND r.use_default=0)
  ORDER BY (r.shop_id IS NOT NULL) DESC LIMIT 1
$$;
CREATE TABLE foliyo_fee_quotes (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  source_type TEXT NOT NULL CHECK(source_type IN ('BOOKING','CHAIR')),
  source_id TEXT NOT NULL,
  fee_bps INTEGER NOT NULL CHECK(fee_bps BETWEEN 0 AND 2000),
  fixed_pence INTEGER NOT NULL CHECK(fixed_pence BETWEEN 0 AND 500),
  rule_scope TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(source_type,source_id)
);
CREATE TRIGGER foliyo_quotes_immutable BEFORE UPDATE OR DELETE ON foliyo_fee_quotes FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
CREATE FUNCTION foliyo_snapshot_fee() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT;
BEGIN
  kind:=CASE WHEN TG_TABLE_NAME='bookings' THEN 'BOOKING' ELSE 'CHAIR' END;
  INSERT INTO foliyo_fee_quotes(id,shop_id,source_type,source_id,fee_bps,fixed_pence,rule_scope,rule_version,created_at)
    SELECT kind||':'||NEW.id,NEW.shop_id,kind,NEW.id,f.fee_bps,f.fixed_pence,f.rule_scope,f.rule_version,NEW.created_at
    FROM foliyo_effective_fee(NEW.shop_id) f ON CONFLICT(source_type,source_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER foliyo_booking_fee AFTER INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION foliyo_snapshot_fee();
CREATE TRIGGER foliyo_chair_fee AFTER INSERT ON payment_requests FOR EACH ROW EXECUTE FUNCTION foliyo_snapshot_fee();
-- Existing, uncompleted flows retain the pre-migration global tariff. No historic charge is repriced.
INSERT INTO foliyo_fee_quotes(id,shop_id,source_type,source_id,fee_bps,fixed_pence,rule_scope,rule_version,created_at)
  SELECT 'BOOKING:'||b.id,b.shop_id,'BOOKING',b.id,p.fee_bps,p.fee_fixed_pence,'legacy',0,b.created_at FROM bookings b CROSS JOIN platform_payments p WHERE p.id=1;
INSERT INTO foliyo_fee_quotes(id,shop_id,source_type,source_id,fee_bps,fixed_pence,rule_scope,rule_version,created_at)
  SELECT 'CHAIR:'||r.id,r.shop_id,'CHAIR',r.id,p.fee_bps,p.fee_fixed_pence,'legacy',0,r.created_at FROM payment_requests r CROSS JOIN platform_payments p WHERE p.id=1;

CREATE TABLE foliyo_fee_charges (
  payment_intent TEXT PRIMARY KEY REFERENCES wallet_receipts(payment_intent),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  booking_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross_pence BIGINT NOT NULL,
  fee_pence BIGINT NOT NULL CHECK(fee_pence>=0 AND fee_pence<=gross_pence),
  quote_id TEXT REFERENCES foliyo_fee_quotes(id),
  created_at BIGINT NOT NULL
);
CREATE TRIGGER foliyo_charges_immutable BEFORE UPDATE OR DELETE ON foliyo_fee_charges FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
CREATE TABLE foliyo_fee_credits (
  request_id TEXT PRIMARY KEY,
  payment_intent TEXT NOT NULL REFERENCES foliyo_fee_charges(payment_intent),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  amount_pence BIGINT NOT NULL CHECK(amount_pence>0),
  adjustment_id TEXT NOT NULL UNIQUE REFERENCES invoice_adjustments(id),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TRIGGER foliyo_credits_immutable BEFORE UPDATE OR DELETE ON foliyo_fee_credits FOR EACH ROW EXECUTE FUNCTION wallet_append_only();
CREATE FUNCTION foliyo_fee_credit_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE charge foliyo_fee_charges; used BIGINT;
BEGIN
  -- Serialize credits without mutating immutable financial history.
  PERFORM pg_advisory_xact_lock(hashtextextended('fee-credit:'||NEW.payment_intent,0));
  SELECT * INTO charge FROM foliyo_fee_charges WHERE payment_intent=NEW.payment_intent;
  SELECT COALESCE(SUM(amount_pence),0) INTO used FROM foliyo_fee_credits WHERE payment_intent=NEW.payment_intent;
  IF charge.shop_id<>NEW.shop_id OR used+NEW.amount_pence>charge.fee_pence OR charge.currency<>'GBP' THEN
    RAISE EXCEPTION 'fee_credit_exceeds_charge';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER foliyo_credit_limit BEFORE INSERT ON foliyo_fee_credits FOR EACH ROW EXECUTE FUNCTION foliyo_fee_credit_limit();
CREATE FUNCTION foliyo_record_fee_charge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q TEXT;
BEGIN
  SELECT id INTO q FROM foliyo_fee_quotes WHERE source_type='CHAIR' AND source_id=(SELECT id FROM payment_requests WHERE stripe_payment_intent=NEW.payment_intent LIMIT 1);
  IF q IS NULL THEN SELECT id INTO q FROM foliyo_fee_quotes WHERE source_type='BOOKING' AND source_id=NEW.booking_id; END IF;
  INSERT INTO foliyo_fee_charges(payment_intent,shop_id,booking_id,currency,gross_pence,fee_pence,quote_id,created_at)
    VALUES(NEW.payment_intent,NEW.shop_id,NEW.booking_id,NEW.currency,NEW.gross_pence,NEW.fee_pence,q,NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER foliyo_charge_received AFTER INSERT ON wallet_receipts FOR EACH ROW EXECUTE FUNCTION foliyo_record_fee_charge();
INSERT INTO foliyo_fee_charges(payment_intent,shop_id,booking_id,currency,gross_pence,fee_pence,created_at)
  SELECT payment_intent,shop_id,booking_id,currency,gross_pence,fee_pence,created_at FROM wallet_receipts;

CREATE OR REPLACE FUNCTION wallet_record_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cur TEXT; fee BIGINT;
BEGIN
  IF NEW.deposit_status='PAID' AND OLD.deposit_status IS DISTINCT FROM NEW.deposit_status AND NEW.stripe_payment_intent<>'' AND NEW.deposit_paid_pence>0 THEN
    SELECT currency INTO cur FROM shops WHERE id=NEW.shop_id;
    SELECT LEAST(NEW.deposit_paid_pence,round(NEW.deposit_paid_pence*fee_bps/10000.0)+fixed_pence) INTO fee
      FROM foliyo_fee_quotes WHERE source_type='BOOKING' AND source_id=NEW.id AND shop_id=NEW.shop_id;
    IF fee IS NULL THEN RAISE EXCEPTION 'fee_snapshot_missing'; END IF;
    INSERT INTO wallet_receipts(payment_intent,shop_id,booking_id,currency,gross_pence,fee_pence,created_at)
      VALUES(NEW.stripe_payment_intent,NEW.shop_id,NEW.id,cur,NEW.deposit_paid_pence,fee,NEW.updated_at) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t TEXT; r TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['foliyo_fee_rules','foliyo_fee_quotes','foliyo_fee_charges','foliyo_fee_credits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
    END LOOP;
  END LOOP;
END $$;
