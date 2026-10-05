-- Preserve original invoice value independently of later credit notes.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS original_total_pence INTEGER;
UPDATE invoices SET original_total_pence=subtotal_pence-discount_pence+tax_pence-COALESCE(credit_applied_pence,0) WHERE original_total_pence IS NULL;
CREATE OR REPLACE FUNCTION ollo_invoice_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.original_total_pence := NEW.total_pence;
  ELSIF NEW.original_total_pence IS DISTINCT FROM OLD.original_total_pence THEN RAISE EXCEPTION 'invoice_original_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_original_guard BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION ollo_invoice_original();

-- A controlled erasure may remove content, but cannot rewrite a message into different content.
CREATE OR REPLACE FUNCTION ollo_notifications_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ollo_erasing() AND NEW.recipient='' AND NEW.body='' AND NEW.html='' AND NEW.subject='' THEN
    IF NEW.shop_id<>OLD.shop_id OR NEW.id<>OLD.id OR NEW.template<>OLD.template OR NEW.channel<>OLD.channel
       OR NEW.related_type<>OLD.related_type OR NEW.related_id<>OLD.related_id OR NEW.created_at<>OLD.created_at THEN
      PERFORM ollo_abort('notification_immutable');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.body<>OLD.body OR NEW.recipient<>OLD.recipient OR NEW.template<>OLD.template OR NEW.channel<>OLD.channel
     OR NEW.related_type<>OLD.related_type OR NEW.related_id<>OLD.related_id OR NEW.created_at<>OLD.created_at THEN
    PERFORM ollo_abort('notification_immutable');
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION ollo_notification_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SENT','FAILED','SKIPPED') AND (
    OLD.created_at < (extract(epoch FROM clock_timestamp())*1000)::bigint - 180*86400000::bigint
    OR (OLD.template IN ('signin_code','verify_contact','password_reset','account_reset','account_welcome','owner_welcome','email_verify','owner_signin_link','staff_invite')
        AND OLD.created_at < (extract(epoch FROM clock_timestamp())*1000)::bigint - 86400000::bigint)
  ) THEN RETURN OLD; END IF;
  PERFORM ollo_abort('notification_immutable'); RETURN NULL;
END $$;
DROP TRIGGER notifications_no_delete ON notifications;
CREATE TRIGGER notifications_no_delete BEFORE DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION ollo_notification_retention();
