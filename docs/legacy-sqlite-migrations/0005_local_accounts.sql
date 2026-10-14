-- Local-test application identity, deliberately independent of hosted-site admission.
CREATE TABLE app_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE shop_owners (
  shop_id TEXT PRIMARY KEY REFERENCES shops(id),
  user_id TEXT NOT NULL UNIQUE REFERENCES app_users(id)
);
CREATE TABLE app_memberships (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  user_id TEXT NOT NULL UNIQUE REFERENCES app_users(id),
  role TEXT NOT NULL CHECK(role IN ('OWNER','MANAGER','RECEPTION','BARBER')),
  staff_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(shop_id,id),
  UNIQUE(shop_id,staff_id),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id),
  CHECK((role='OWNER' AND staff_id IS NULL) OR (role<>'OWNER' AND staff_id IS NOT NULL))
);
CREATE TABLE app_sessions (
  token_hash TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL REFERENCES app_memberships(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX app_sessions_member ON app_sessions(membership_id);
CREATE TABLE staff_invitations (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('MANAGER','RECEPTION','BARBER')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX invitations_shop ON staff_invitations(shop_id,created_at);
CREATE TABLE auth_throttle (
  key_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  resets_at INTEGER NOT NULL
);
-- Batch assertion: a zero-row optimistic write aborts the entire transaction.
CREATE TABLE account_assertions (ok INTEGER NOT NULL CONSTRAINT account_changed CHECK(ok=1));
-- Prevent accidental owner demotion/deactivation through future code paths.
CREATE TRIGGER protect_owner_membership_update BEFORE UPDATE ON app_memberships
WHEN OLD.role='OWNER' AND (NEW.role<>'OWNER' OR NEW.active<>1 OR NEW.user_id<>OLD.user_id OR NEW.shop_id<>OLD.shop_id)
BEGIN SELECT RAISE(ABORT,'owner_protected'); END;
CREATE TRIGGER protect_owner_membership_delete BEFORE DELETE ON app_memberships
WHEN OLD.role='OWNER'
BEGIN SELECT RAISE(ABORT,'owner_protected'); END;
-- Membership creation cannot win a stale/revoked invite race.
CREATE TRIGGER validate_invited_membership BEFORE INSERT ON app_memberships
WHEN NEW.role<>'OWNER' AND NOT EXISTS (
  SELECT 1 FROM staff_invitations i JOIN app_users u ON u.id=NEW.user_id
  JOIN staff s ON s.shop_id=i.shop_id AND s.id=i.staff_id
  WHERE i.shop_id=NEW.shop_id AND i.staff_id=NEW.staff_id AND i.email=u.email
    AND i.role=NEW.role AND i.accepted_at IS NULL AND i.revoked=0
    AND i.expires_at>unixepoch()*1000 AND s.active=1
)
BEGIN SELECT RAISE(ABORT,'invitation_unavailable'); END;
