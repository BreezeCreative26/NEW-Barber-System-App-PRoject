-- Walk-in bookings may have an empty phone; do not create a customer row for them.
CREATE OR REPLACE FUNCTION ollo_booking_customer_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Walk-ins without a number stay unlinked: no shared "walk-in" customer record.
  IF NEW.customer_id IS NULL AND NEW.phone <> '' THEN
    INSERT INTO customers(id,shop_id,name,phone,email,created_at,updated_at)
    VALUES(gen_random_uuid()::text, NEW.shop_id, NEW.customer_name, NEW.phone, NEW.email, NEW.created_at, NEW.created_at)
    ON CONFLICT (shop_id,phone) DO NOTHING;
    UPDATE bookings SET customer_id=(SELECT c.id FROM customers c WHERE c.shop_id=NEW.shop_id AND c.phone=NEW.phone) WHERE id=NEW.id;
  END IF;
  RETURN NULL;
END $$;
