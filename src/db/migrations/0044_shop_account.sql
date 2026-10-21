-- Shop account model: a business shop has a free shop login (no barber profile, not a seat) and
-- then invites the owner and barbers as normal team members. Individuals are priced as one seat.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'BUSINESS';
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_account_type_check;
ALTER TABLE shops ADD CONSTRAINT shops_account_type_check CHECK (account_type IN ('BUSINESS','INDIVIDUAL'));

ALTER TABLE app_memberships DROP CONSTRAINT IF EXISTS app_memberships_check;
ALTER TABLE app_memberships DROP CONSTRAINT IF EXISTS app_memberships_role_check;
ALTER TABLE app_memberships ADD CONSTRAINT app_memberships_role_check CHECK (role IN ('OWNER','MANAGER','RECEPTION','BARBER','SHOP'));
ALTER TABLE app_memberships ADD CONSTRAINT app_memberships_check CHECK (
  (role = 'SHOP' AND staff_id IS NULL) OR (role = 'OWNER') OR (role IN ('MANAGER','RECEPTION','BARBER') AND staff_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION ollo_validate_invited_membership() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.role <> 'SHOP' AND (NEW.role <> 'OWNER' OR NEW.staff_id IS NOT NULL) AND NOT EXISTS (
    SELECT 1 FROM staff_invitations i JOIN app_users u ON u.id=NEW.user_id
    JOIN staff s ON s.shop_id=i.shop_id AND s.id=i.staff_id
    WHERE i.shop_id=NEW.shop_id AND i.staff_id=NEW.staff_id AND i.email=u.email
      AND i.role=NEW.role AND i.accepted_at IS NULL AND i.revoked=0
      AND i.expires_at > (EXTRACT(EPOCH FROM now())*1000)::bigint AND s.active=1
  ) THEN PERFORM ollo_abort('invitation_unavailable'); END IF;
  RETURN NEW;
END $f$;

INSERT INTO plans(id,name,monthly_pence,included_seats,seat_pence,stripe_price_id,stripe_seat_price_id,active,sort,created_at,updated_at)
VALUES('solo','foliyo individual',799,1,799,'','',1,1,0,0) ON CONFLICT(id) DO NOTHING;

ALTER TABLE staff_invitations DROP CONSTRAINT IF EXISTS staff_invitations_role_check;
ALTER TABLE staff_invitations ADD CONSTRAINT staff_invitations_role_check CHECK (role IN ('OWNER','MANAGER','RECEPTION','BARBER'));

-- Per-person extras for barbers: see everyone's calendar, whole-shop insights, pay runs, or manage services and settings.
ALTER TABLE app_memberships ADD COLUMN IF NOT EXISTS permissions_json TEXT NOT NULL DEFAULT '{}';
