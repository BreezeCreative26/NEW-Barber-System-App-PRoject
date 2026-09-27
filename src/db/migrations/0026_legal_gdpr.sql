-- GDPR framework: recorded acceptance of legal documents, and right-to-erasure marker.
-- Documents (terms, privacy, dpa, cookies) live in code (src/server/legal.ts) with a version
-- string each; every acceptance stores which version was agreed, when, by whom, from where.
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,   -- owner / staff (controller side)
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  customer_account_id TEXT,                                    -- signed-in customer, if any
  subject TEXT NOT NULL,                                       -- 'OWNER' | 'STAFF' | 'CUSTOMER'
  document TEXT NOT NULL CHECK (document IN ('terms','privacy','dpa','cookies')),
  version TEXT NOT NULL,
  accepted_at BIGINT NOT NULL,
  ip_hash TEXT NOT NULL DEFAULT '',                            -- sha256 of client IP, never the IP
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS legal_acceptances_user ON legal_acceptances(user_id, document, accepted_at DESC);
CREATE INDEX IF NOT EXISTS legal_acceptances_shop ON legal_acceptances(shop_id, document, accepted_at DESC);

-- Right to erasure (UK GDPR Art. 17). The row stays so bookings, payments and pay runs keep their
-- integrity, but every personal field is blanked and the marker set. See POST /customers/:id/erase.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS erased_at BIGINT;

-- Erasure runs inside one transaction with this flag set, so the message log can have its
-- recipient blanked (the trigger otherwise keeps notifications immutable). Nothing else honours it.
CREATE OR REPLACE FUNCTION ollo_erasing() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('ollo.erase', true), '') = '1' $$;
CREATE OR REPLACE FUNCTION ollo_notifications_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body<>OLD.body OR (NEW.recipient<>OLD.recipient AND NOT ollo_erasing()) OR NEW.template<>OLD.template OR NEW.channel<>OLD.channel
     OR NEW.related_type<>OLD.related_type OR NEW.related_id<>OLD.related_id OR NEW.created_at<>OLD.created_at THEN
    PERFORM ollo_abort('notification_immutable');
  END IF;
  RETURN NEW;
END $$;
-- Reviews keep rating/body/booking; display_name may be blanked when erasing.
CREATE OR REPLACE FUNCTION ollo_reviews_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rating<>OLD.rating OR NEW.body<>OLD.body OR NEW.booking_id<>OLD.booking_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.staff_id<>OLD.staff_id OR (NEW.display_name<>OLD.display_name AND NOT ollo_erasing()) OR NEW.created_at<>OLD.created_at THEN
    PERFORM ollo_abort('review_immutable');
  END IF;
  RETURN NEW;
END $$;
