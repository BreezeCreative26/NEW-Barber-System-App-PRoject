-- OLLO — Postgres schema. Ported from 17 SQLite migrations (see git history, migrations/*.sql).
-- Conventions kept from the original so the server ports 1:1:
--   ids are TEXT (uuid strings); booleans are INTEGER 0/1; instants are BIGINT epoch millis;
--   dates are TEXT 'YYYY-MM-DD'; JSON payloads are TEXT (validated with ::jsonb where needed).
-- Every business row carries shop_id. Guards that protect money and slots live here as triggers.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Shops, staff, catalogue ----------
CREATE TABLE shops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  currency TEXT NOT NULL DEFAULT 'GBP' CHECK(currency ~ '^[A-Z]{3}$'),
  opens INTEGER NOT NULL DEFAULT 540 CHECK(opens BETWEEN 0 AND 1439),
  closes INTEGER NOT NULL DEFAULT 1080 CHECK(closes BETWEEN 1 AND 1440 AND closes > opens),
  closed_days TEXT NOT NULL DEFAULT '[0]',
  -- Per-day opening hours [{enabled,starts,ends} x 7, index = weekday]. opens/closes/closed_days are
  -- derived from this on write (earliest open, latest close, disabled days) so range queries stay simple.
  week_json TEXT NOT NULL DEFAULT '[{"enabled":0,"starts":540,"ends":1080},{"enabled":1,"starts":540,"ends":1080},{"enabled":1,"starts":540,"ends":1080},{"enabled":1,"starts":540,"ends":1080},{"enabled":1,"starts":540,"ends":1080},{"enabled":1,"starts":540,"ends":1080},{"enabled":1,"starts":540,"ends":1080}]',
  deposit_pence INTEGER NOT NULL DEFAULT 500 CHECK(deposit_pence >= 0),
  cancel_hours INTEGER NOT NULL DEFAULT 24 CHECK(cancel_hours BETWEEN 0 AND 168),
  no_show_grace INTEGER NOT NULL DEFAULT 15 CHECK(no_show_grace BETWEEN 0 AND 120),
  version INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  slug TEXT,
  online_booking INTEGER NOT NULL DEFAULT 0 CHECK(online_booking IN (0,1)),
  lead_time_min INTEGER NOT NULL DEFAULT 60 CHECK(lead_time_min BETWEEN 0 AND 10080),
  booking_window_days INTEGER NOT NULL DEFAULT 42 CHECK(booking_window_days BETWEEN 1 AND 365),
  till_access TEXT NOT NULL DEFAULT 'OWNER' CHECK(till_access IN ('OWNER','ALL')),
  waitlist_auto_offer INTEGER NOT NULL DEFAULT 1 CHECK(waitlist_auto_offer IN (0,1)),
  waitlist_offer_hold_min INTEGER NOT NULL DEFAULT 120 CHECK(waitlist_offer_hold_min BETWEEN 15 AND 1440),
  waitlist_templates_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX shops_slug ON shops(slug) WHERE slug IS NOT NULL;

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Barber',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  colour TEXT NOT NULL DEFAULT 'sage' CHECK(colour IN ('sage','sand','blue','clay','plum','slate')),
  photo_url TEXT NOT NULL DEFAULT '',
  online_visible INTEGER NOT NULL DEFAULT 1 CHECK(online_visible IN (0,1)),
  skills TEXT NOT NULL DEFAULT '[]',
  instagram TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  commission_pct INTEGER NOT NULL DEFAULT 50 CHECK(commission_pct BETWEEN 0 AND 100),
  pay_model TEXT NOT NULL DEFAULT 'COMMISSION' CHECK(pay_model IN ('COMMISSION','CHAIR_RENT','HOURLY','SALARY','HYBRID')),
  pay_period TEXT NOT NULL DEFAULT 'WEEKLY' CHECK(pay_period IN ('WEEKLY','FORTNIGHTLY','MONTHLY')),
  base_pence INTEGER NOT NULL DEFAULT 0 CHECK(base_pence >= 0),
  hourly_pence INTEGER NOT NULL DEFAULT 0 CHECK(hourly_pence >= 0),
  rent_pence INTEGER NOT NULL DEFAULT 0 CHECK(rent_pence >= 0),
  commission_threshold_pence INTEGER NOT NULL DEFAULT 0 CHECK(commission_threshold_pence >= 0),
  commission_tiers TEXT NOT NULL DEFAULT '[]',
  tip_share_pct INTEGER NOT NULL DEFAULT 100 CHECK(tip_share_pct BETWEEN 0 AND 100),
  product_commission_pct INTEGER NOT NULL DEFAULT 0 CHECK(product_commission_pct BETWEEN 0 AND 100),
  employment TEXT NOT NULL DEFAULT 'SELF_EMPLOYED' CHECK(employment IN ('SELF_EMPLOYED','EMPLOYED')),
  pay_notes TEXT NOT NULL DEFAULT '',
  UNIQUE(shop_id,id)
);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Hair',
  duration_min INTEGER NOT NULL CHECK(duration_min BETWEEN 5 AND 240),
  price_pence INTEGER NOT NULL CHECK(price_pence BETWEEN 0 AND 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  colour TEXT NOT NULL DEFAULT 'sage' CHECK(colour IN ('sage','sand','blue','clay','plum','slate')),
  online_bookable INTEGER NOT NULL DEFAULT 1 CHECK(online_bookable IN (0,1)),
  popular INTEGER NOT NULL DEFAULT 0 CHECK(popular IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(shop_id,id)
);

CREATE TABLE addons (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK(duration_min BETWEEN 0 AND 120),
  price_pence INTEGER NOT NULL CHECK(price_pence BETWEEN 0 AND 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(shop_id,id)
);
CREATE TABLE addon_services (
  shop_id TEXT NOT NULL, addon_id TEXT NOT NULL, service_id TEXT NOT NULL,
  PRIMARY KEY(shop_id,addon_id,service_id),
  FOREIGN KEY(shop_id,addon_id) REFERENCES addons(shop_id,id),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);

CREATE TABLE staff_hours (
  shop_id TEXT NOT NULL, staff_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  starts INTEGER NOT NULL CHECK(starts BETWEEN 0 AND 1439),
  ends INTEGER NOT NULL CHECK(ends BETWEEN 1 AND 1440 AND ends > starts),
  break_start INTEGER NOT NULL CHECK(break_start >= starts),
  break_end INTEGER NOT NULL CHECK(break_end >= break_start AND break_end <= ends),
  PRIMARY KEY(shop_id,staff_id,weekday),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE TABLE staff_schedule_overrides (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, staff_id TEXT NOT NULL, date TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  starts INTEGER NOT NULL CHECK(starts BETWEEN 0 AND 1439),
  ends INTEGER NOT NULL CHECK(ends BETWEEN 1 AND 1440 AND ends>starts),
  break_start INTEGER NOT NULL CHECK(break_start>=starts),
  break_end INTEGER NOT NULL CHECK(break_end>=break_start AND break_end<=ends),
  reason TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(shop_id,staff_id,date),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE TABLE staff_days_off (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, staff_id TEXT NOT NULL, date TEXT NOT NULL,
  reason TEXT NOT NULL, created_at BIGINT NOT NULL,
  UNIQUE(shop_id,staff_id,date),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX staff_days_off_dates ON staff_days_off(shop_id,date,staff_id);
CREATE TABLE staff_service_rules (
  shop_id TEXT NOT NULL, staff_id TEXT NOT NULL, service_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  price_pence INTEGER CHECK(price_pence BETWEEN 0 AND 100000),
  duration_min INTEGER CHECK(duration_min BETWEEN 5 AND 240),
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(shop_id,staff_id,service_id),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
CREATE TABLE holidays (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id), date TEXT NOT NULL, label TEXT NOT NULL,
  UNIQUE(shop_id,date)
);

-- ---------- Accounts (staff logins) ----------
CREATE TABLE app_users (
  id TEXT PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at BIGINT NOT NULL
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
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX app_sessions_member ON app_sessions(membership_id);
CREATE TABLE staff_invitations (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT NOT NULL,
  email CITEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('MANAGER','RECEPTION','BARBER')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  accepted_at BIGINT,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX invitations_shop ON staff_invitations(shop_id,created_at);
CREATE TABLE auth_throttle (key_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, resets_at BIGINT NOT NULL);
-- Legacy capability sessions (pre-account workspaces). Kept so the existing routers compile; unused for new shops.
CREATE TABLE sandbox_sessions (token_hash TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id), expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX sessions_shop ON sandbox_sessions(shop_id);
-- Batch assertion helper: INSERT INTO account_assertions(ok) VALUES(<rowcount>) aborts when 0.
CREATE TABLE account_assertions (ok INTEGER NOT NULL CONSTRAINT account_changed CHECK(ok=1));

-- ---------- Customers ----------
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  birthday TEXT,
  preferred_staff_id TEXT,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(marketing_opt_in IN (0,1)),
  merged_into TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(shop_id,id),
  UNIQUE(shop_id,phone),
  FOREIGN KEY(shop_id,preferred_staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX customers_shop_name ON customers(shop_id,name);
CREATE TABLE customer_accounts (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE customer_account_links (
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  shop_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  linked_at BIGINT NOT NULL,
  PRIMARY KEY (account_id, shop_id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id)
);
CREATE INDEX customer_account_links_customer ON customer_account_links(shop_id, customer_id);
CREATE TABLE customer_otp (
  shop_id TEXT NOT NULL REFERENCES shops(id), phone TEXT NOT NULL, code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, phone)
);
CREATE TABLE customer_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX customer_sessions_account ON customer_sessions(account_id, shop_id);

-- ---------- Bookings ----------
CREATE TABLE booking_series (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT NOT NULL, service_id TEXT NOT NULL,
  customer_name TEXT NOT NULL, phone TEXT NOT NULL,
  interval_weeks INTEGER NOT NULL CHECK(interval_weeks BETWEEN 1 AND 12),
  start_date TEXT NOT NULL, start_min INTEGER NOT NULL,
  occurrences INTEGER NOT NULL CHECK(occurrences BETWEEN 2 AND 26),
  created_at BIGINT NOT NULL,
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  sequence INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL CHECK(end_at > start_at),
  duration_min INTEGER NOT NULL,
  buffer_min INTEGER NOT NULL DEFAULT 10 CHECK(buffer_min = 10),
  service_name TEXT NOT NULL,
  price_pence INTEGER NOT NULL CHECK(price_pence >= 0),
  deposit_policy_pence INTEGER NOT NULL CHECK(deposit_policy_pence >= 0),
  cancel_hours_snapshot INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('TEST_BOOKING','WALK_IN')),
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED','CANCELLED','NO_SHOW')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  quoted_service_version INTEGER,
  quoted_shop_version INTEGER,
  items_json TEXT NOT NULL DEFAULT '[]' CHECK(items_json::jsonb IS NOT NULL),
  channel TEXT NOT NULL DEFAULT 'OWNER' CHECK(channel IN ('OWNER','ONLINE')),
  email TEXT NOT NULL DEFAULT '',
  series_id TEXT,
  customer_id TEXT,
  attendee_name TEXT NOT NULL DEFAULT '',
  group_id TEXT,
  UNIQUE(shop_id,id),
  UNIQUE(shop_id,sequence),
  UNIQUE(shop_id,request_id),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
CREATE INDEX booking_customer ON bookings(shop_id,customer_id,start_at);
CREATE INDEX booking_customers ON bookings(shop_id,phone,start_at);
CREATE INDEX booking_days ON bookings(shop_id,date);
CREATE INDEX booking_group_lookup ON bookings(shop_id, group_id);
CREATE INDEX booking_intervals ON bookings(shop_id,staff_id,start_at,end_at,status);
CREATE INDEX booking_series_lookup ON bookings(shop_id,series_id);
CREATE TABLE booking_manage_tokens (
  token_hash TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  booking_id TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  FOREIGN KEY(shop_id,booking_id) REFERENCES bookings(shop_id,id)
);

-- ---------- Money ----------
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  booking_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  customer_id TEXT,
  date TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('CARD','CASH','TRANSFER','VOUCHER')),
  service_pence INTEGER NOT NULL CHECK(service_pence >= 0),
  tip_pence INTEGER NOT NULL DEFAULT 0 CHECK(tip_pence >= 0),
  discount_pence INTEGER NOT NULL DEFAULT 0 CHECK(discount_pence >= 0),
  commission_pct INTEGER NOT NULL CHECK(commission_pct BETWEEN 0 AND 100),
  note TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL,
  voided_at BIGINT,
  void_reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  FOREIGN KEY(shop_id,booking_id) REFERENCES bookings(shop_id,id),
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX payments_booking ON payments(shop_id,booking_id);
CREATE INDEX payments_shop_date ON payments(shop_id,date,created_at);
CREATE INDEX payments_staff_date ON payments(shop_id,staff_id,date);
CREATE TABLE pay_runs (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT NOT NULL,
  period_from TEXT NOT NULL, period_to TEXT NOT NULL,
  pay_model TEXT NOT NULL, terms_json TEXT NOT NULL,
  service_pence INTEGER NOT NULL DEFAULT 0, tips_pence INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0, hours_x100 INTEGER NOT NULL DEFAULT 0,
  commission_pence INTEGER NOT NULL DEFAULT 0, base_pence INTEGER NOT NULL DEFAULT 0,
  hourly_pence INTEGER NOT NULL DEFAULT 0, tip_pence INTEGER NOT NULL DEFAULT 0,
  rent_pence INTEGER NOT NULL DEFAULT 0,
  adjustments_json TEXT NOT NULL DEFAULT '[]', adjustments_pence INTEGER NOT NULL DEFAULT 0,
  net_pence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','PAID','VOID')),
  paid_method TEXT, paid_reference TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id)
);
CREATE INDEX pay_runs_shop_period ON pay_runs(shop_id,period_from,period_to);
CREATE INDEX pay_runs_staff ON pay_runs(shop_id,staff_id,period_from);
CREATE UNIQUE INDEX pay_runs_unique_live ON pay_runs(shop_id,staff_id,period_from,period_to) WHERE status<>'VOID';

-- ---------- Audit, waiting list, messages, presence ----------
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX audit_shop_time ON audit_events(shop_id,created_at);
CREATE TABLE waitlist_entries (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  staff_id TEXT, service_id TEXT NOT NULL,
  customer_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  daypart TEXT NOT NULL DEFAULT 'ANY' CHECK(daypart IN ('ANY','MORNING','AFTERNOON','EVENING')),
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','OFFERED','BOOKED','CLOSED','EXPIRED')),
  booking_id TEXT, offer_id TEXT, offers_made INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  UNIQUE(shop_id,date,phone,service_id),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id)
);
CREATE INDEX waitlist_shop_date ON waitlist_entries(shop_id,status,date);
CREATE TABLE waitlist_offers (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  entry_id TEXT NOT NULL REFERENCES waitlist_entries(id),
  staff_id TEXT NOT NULL, service_id TEXT NOT NULL, date TEXT NOT NULL, start_min INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED','SUPERSEDED','LOST')),
  source TEXT NOT NULL CHECK(source IN ('MANUAL','AUTO')),
  booking_id TEXT,
  expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, responded_at BIGINT
);
CREATE INDEX waitlist_offers_entry ON waitlist_offers(shop_id,entry_id,status);
CREATE INDEX waitlist_offers_slot ON waitlist_offers(shop_id,staff_id,date,start_min,status);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  channel TEXT NOT NULL CHECK(channel IN ('SMS','EMAIL')),
  recipient TEXT NOT NULL, template TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','SENT','FAILED','SKIPPED')),
  status_note TEXT NOT NULL DEFAULT '',
  related_type TEXT NOT NULL DEFAULT '', related_id TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL, sent_at BIGINT
);
CREATE INDEX notifications_shop ON notifications(shop_id,created_at);
CREATE TABLE shop_pages (
  shop_id TEXT PRIMARY KEY REFERENCES shops(id),
  strapline TEXT NOT NULL DEFAULT '', about TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '', logo_url TEXT NOT NULL DEFAULT '', gallery_json TEXT NOT NULL DEFAULT '[]',
  phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', instagram TEXT NOT NULL DEFAULT '',
  map_url TEXT NOT NULL DEFAULT '', transport_note TEXT NOT NULL DEFAULT '', policy_text TEXT NOT NULL DEFAULT '',
  sections_json TEXT NOT NULL DEFAULT '["hero","next","services","team","hours","gallery","reviews","find","policies"]',
  accent TEXT NOT NULL DEFAULT 'ollo' CHECK(accent IN ('ollo','ink','sage','clay','plum','slate')),
  theme_json TEXT NOT NULL DEFAULT '{}',
  published INTEGER NOT NULL DEFAULT 1 CHECK(published IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  customer_id TEXT, staff_id TEXT NOT NULL, service_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK(status IN ('PUBLISHED','HIDDEN')),
  reply TEXT NOT NULL DEFAULT '', reply_at BIGINT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX reviews_shop_status ON reviews(shop_id,status,created_at);
CREATE INDEX reviews_staff ON reviews(shop_id,staff_id);
CREATE TABLE shop_media (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  kind TEXT NOT NULL CHECK(kind IN ('cover','gallery','staff')),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER, height INTEGER,
  alt TEXT NOT NULL DEFAULT '', uploaded_by TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX shop_media_shop ON shop_media(shop_id,created_at);

-- =====================================================================================
-- Guards. Each raises with the same short code the app already maps to a 409.
-- =====================================================================================
CREATE OR REPLACE FUNCTION ollo_abort(code TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '%', code USING ERRCODE = 'P0001'; END $$;

-- Weekday (0=Sunday) of a 'YYYY-MM-DD' text date, matching SQLite strftime('%w').
CREATE OR REPLACE FUNCTION ollo_weekday(d TEXT) RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT EXTRACT(DOW FROM d::date)::int $$;

-- Immutable / delete-protected tables --------------------------------------------------
CREATE OR REPLACE FUNCTION ollo_deny() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM ollo_abort(TG_ARGV[0]); RETURN NULL; END $$;
CREATE TRIGGER prevent_audit_update BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION ollo_deny('audit_immutable');
CREATE TRIGGER prevent_audit_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION ollo_deny('audit_immutable');
CREATE TRIGGER prevent_booking_delete BEFORE DELETE ON bookings FOR EACH ROW EXECUTE FUNCTION ollo_deny('booking_delete_forbidden');
CREATE TRIGGER prevent_customer_delete BEFORE DELETE ON customers FOR EACH ROW EXECUTE FUNCTION ollo_deny('customer_delete_forbidden');
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION ollo_deny('payment_delete_forbidden');
CREATE TRIGGER pay_runs_no_delete BEFORE DELETE ON pay_runs FOR EACH ROW EXECUTE FUNCTION ollo_deny('pay_run_delete_forbidden');
CREATE TRIGGER notifications_no_delete BEFORE DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION ollo_deny('notification_immutable');

CREATE OR REPLACE FUNCTION ollo_notifications_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body<>OLD.body OR NEW.recipient<>OLD.recipient OR NEW.template<>OLD.template OR NEW.channel<>OLD.channel
     OR NEW.related_type<>OLD.related_type OR NEW.related_id<>OLD.related_id OR NEW.created_at<>OLD.created_at THEN
    PERFORM ollo_abort('notification_immutable');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_immutable_body BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION ollo_notifications_immutable();

CREATE OR REPLACE FUNCTION ollo_reviews_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rating<>OLD.rating OR NEW.body<>OLD.body OR NEW.booking_id<>OLD.booking_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.staff_id<>OLD.staff_id OR NEW.display_name<>OLD.display_name OR NEW.created_at<>OLD.created_at THEN
    PERFORM ollo_abort('review_immutable');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reviews_immutable_verdict BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION ollo_reviews_immutable();

-- Owner membership protection -----------------------------------------------------------
CREATE OR REPLACE FUNCTION ollo_owner_protected() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.role='OWNER' THEN PERFORM ollo_abort('owner_protected'); END IF;
    RETURN OLD;
  END IF;
  IF OLD.role='OWNER' AND (NEW.role<>'OWNER' OR NEW.active<>1 OR NEW.user_id<>OLD.user_id OR NEW.shop_id<>OLD.shop_id) THEN
    PERFORM ollo_abort('owner_protected');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_owner_membership_update BEFORE UPDATE ON app_memberships FOR EACH ROW EXECUTE FUNCTION ollo_owner_protected();
CREATE TRIGGER protect_owner_membership_delete BEFORE DELETE ON app_memberships FOR EACH ROW EXECUTE FUNCTION ollo_owner_protected();

CREATE OR REPLACE FUNCTION ollo_validate_invited_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role<>'OWNER' AND NOT EXISTS (
    SELECT 1 FROM staff_invitations i JOIN app_users u ON u.id=NEW.user_id
    JOIN staff s ON s.shop_id=i.shop_id AND s.id=i.staff_id
    WHERE i.shop_id=NEW.shop_id AND i.staff_id=NEW.staff_id AND i.email=u.email
      AND i.role=NEW.role AND i.accepted_at IS NULL AND i.revoked=0
      AND i.expires_at > (EXTRACT(EPOCH FROM now())*1000)::bigint AND s.active=1
  ) THEN PERFORM ollo_abort('invitation_unavailable'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_invited_membership BEFORE INSERT ON app_memberships FOR EACH ROW EXECUTE FUNCTION ollo_validate_invited_membership();

-- Payments ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ollo_payments_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN PERFORM ollo_abort('payment_already_voided'); END IF;
  IF NEW.id<>OLD.id OR NEW.shop_id<>OLD.shop_id OR NEW.booking_id<>OLD.booking_id OR NEW.staff_id<>OLD.staff_id
     OR NEW.method<>OLD.method OR NEW.service_pence<>OLD.service_pence OR NEW.tip_pence<>OLD.tip_pence
     OR NEW.discount_pence<>OLD.discount_pence OR NEW.commission_pct<>OLD.commission_pct OR NEW.created_at<>OLD.created_at THEN
    PERFORM ollo_abort('payment_immutable');
  END IF;
  IF NEW.voided_at IS NULL THEN PERFORM ollo_abort('payment_void_required'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_immutable BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION ollo_payments_immutable();
CREATE OR REPLACE FUNCTION ollo_payments_visit_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM bookings WHERE shop_id=NEW.shop_id AND id=NEW.booking_id) NOT IN ('IN_SERVICE','COMPLETED') THEN
    PERFORM ollo_abort('payment_visit_not_in_service');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_visit_state BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION ollo_payments_visit_state();

CREATE OR REPLACE FUNCTION ollo_pay_runs_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='PAID' AND NOT (NEW.status='VOID' AND NEW.net_pence=OLD.net_pence AND NEW.terms_json=OLD.terms_json) THEN PERFORM ollo_abort('pay_run_paid_frozen'); END IF;
  IF OLD.status='VOID' THEN PERFORM ollo_abort('pay_run_void_frozen'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pay_runs_paid_frozen BEFORE UPDATE ON pay_runs FOR EACH ROW EXECUTE FUNCTION ollo_pay_runs_frozen();

-- Bookings: snapshots, customers, day off, hours, overlap, items, quote ------------------------
CREATE OR REPLACE FUNCTION ollo_booking_snapshots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.shop_id<>OLD.shop_id OR NEW.sequence<>OLD.sequence OR NEW.request_id<>OLD.request_id
     OR NEW.request_hash<>OLD.request_hash OR NEW.service_id<>OLD.service_id OR NEW.service_name<>OLD.service_name
     OR NEW.price_pence<>OLD.price_pence OR NEW.duration_min<>OLD.duration_min OR NEW.buffer_min<>OLD.buffer_min
     OR NEW.deposit_policy_pence<>OLD.deposit_policy_pence OR NEW.cancel_hours_snapshot<>OLD.cancel_hours_snapshot
     OR NEW.source<>OLD.source OR NEW.created_at<>OLD.created_at
     OR NEW.quoted_service_version IS DISTINCT FROM OLD.quoted_service_version OR NEW.quoted_shop_version IS DISTINCT FROM OLD.quoted_shop_version
     OR NEW.items_json<>OLD.items_json OR NEW.channel<>OLD.channel OR NEW.series_id IS DISTINCT FROM OLD.series_id THEN
    PERFORM ollo_abort('booking_snapshot_immutable');
  END IF;
  IF OLD.group_id IS NOT NULL AND NEW.group_id IS DISTINCT FROM OLD.group_id THEN PERFORM ollo_abort('booking_group_immutable'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_booking_snapshots BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION ollo_booking_snapshots();

CREATE OR REPLACE FUNCTION ollo_booking_customer_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=NEW.customer_id AND c.shop_id=NEW.shop_id) THEN
    PERFORM ollo_abort('customer_scope');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_customer_scope BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION ollo_booking_customer_scope();

-- After insert: link (or create) the shop's customer row for this phone.
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
CREATE TRIGGER booking_customer_link AFTER INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION ollo_booking_customer_link();

-- Shared availability checks for insert and reschedule.
CREATE OR REPLACE FUNCTION ollo_booking_slot_checks(b bookings) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id=b.staff_id AND shop_id=b.shop_id AND active=1) THEN PERFORM ollo_abort('barber_unavailable'); END IF;
  IF EXISTS (SELECT 1 FROM staff_service_rules r WHERE r.shop_id=b.shop_id AND r.staff_id=b.staff_id AND r.service_id=b.service_id AND r.enabled=0) THEN PERFORM ollo_abort('service_ineligible'); END IF;
  IF EXISTS (SELECT 1 FROM holidays WHERE shop_id=b.shop_id AND date=b.date) THEN PERFORM ollo_abort('shop_closed'); END IF;
  IF EXISTS (SELECT 1 FROM staff_days_off d WHERE d.shop_id=b.shop_id AND d.staff_id=b.staff_id AND d.date=b.date) THEN PERFORM ollo_abort('staff_day_off'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM staff_hours h JOIN shops s ON s.id=h.shop_id
    LEFT JOIN staff_schedule_overrides o ON o.shop_id=h.shop_id AND o.staff_id=h.staff_id AND o.date=b.date
    WHERE h.shop_id=b.shop_id AND h.staff_id=b.staff_id AND h.weekday=ollo_weekday(b.date)
      AND COALESCE(o.enabled,h.enabled)=1
      AND b.start_min >= GREATEST(COALESCE(o.starts,h.starts), s.opens, ((s.week_json::jsonb)->h.weekday->>'starts')::int)
      AND b.start_min + b.duration_min + b.buffer_min <= LEAST(COALESCE(o.ends,h.ends), s.closes, ((s.week_json::jsonb)->h.weekday->>'ends')::int)
      AND ((s.week_json::jsonb)->h.weekday->>'enabled')::int = 1
      AND NOT (COALESCE(o.break_end,h.break_end) > COALESCE(o.break_start,h.break_start)
               AND b.start_min < COALESCE(o.break_end,h.break_end)
               AND b.start_min + b.duration_min + b.buffer_min > COALESCE(o.break_start,h.break_start))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.closed_days::jsonb) d WHERE d::int = h.weekday)
  ) THEN PERFORM ollo_abort('outside_hours'); END IF;
  IF b.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED') AND EXISTS (
    SELECT 1 FROM bookings x WHERE x.shop_id=b.shop_id AND x.staff_id=b.staff_id AND x.id<>b.id
      AND x.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')
      AND x.start_at < b.end_at + b.buffer_min * 60000
      AND b.start_at < x.end_at + x.buffer_min * 60000
  ) THEN PERFORM ollo_abort('slot_taken'); END IF;
END $$;

CREATE OR REPLACE FUNCTION ollo_validate_booking_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE items jsonb; first jsonb;
BEGIN
  -- Items snapshot must be a non-empty array whose head is the service and whose totals match.
  BEGIN items := NEW.items_json::jsonb; EXCEPTION WHEN others THEN PERFORM ollo_abort('invalid_booking_items'); END;
  IF jsonb_typeof(items)<>'array' OR jsonb_array_length(items) NOT BETWEEN 1 AND 11 THEN PERFORM ollo_abort('invalid_booking_items'); END IF;
  first := items->0;
  IF first->>'kind' IS DISTINCT FROM 'SERVICE' OR first->>'id' IS DISTINCT FROM NEW.service_id
     OR NEW.price_pence IS DISTINCT FROM (SELECT SUM((v->>'price_pence')::int) FROM jsonb_array_elements(items) v)
     OR NEW.duration_min IS DISTINCT FROM (SELECT SUM((v->>'duration_min')::int) FROM jsonb_array_elements(items) v)
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
    SELECT 1 FROM jsonb_array_elements(items) WITH ORDINALITY j(v, i) WHERE i>1 AND (
      v->>'kind' IS DISTINCT FROM 'ADDON' OR NOT EXISTS (
        SELECT 1 FROM addons a JOIN addon_services l ON l.shop_id=a.shop_id AND l.addon_id=a.id
        WHERE a.shop_id=NEW.shop_id AND a.id=v->>'id' AND a.active=1 AND l.service_id=NEW.service_id
          AND a.name=v->>'name' AND a.price_pence=(v->>'price_pence')::int AND a.duration_min=(v->>'duration_min')::int))
  ) THEN PERFORM ollo_abort('addon_unavailable'); END IF;
  -- Quote must match the current service and shop versions and policy snapshot.
  IF NOT EXISTS (SELECT 1 FROM services WHERE id=NEW.service_id AND shop_id=NEW.shop_id AND version=NEW.quoted_service_version) THEN PERFORM ollo_abort('quote_changed'); END IF;
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id=NEW.shop_id AND version=NEW.quoted_shop_version
                 AND LEAST(deposit_pence, NEW.price_pence)=NEW.deposit_policy_pence AND cancel_hours=NEW.cancel_hours_snapshot) THEN PERFORM ollo_abort('quote_changed'); END IF;
  PERFORM ollo_booking_slot_checks(NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER validate_booking_insert BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION ollo_validate_booking_insert();

CREATE OR REPLACE FUNCTION ollo_validate_booking_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.staff_id<>OLD.staff_id OR NEW.date<>OLD.date OR NEW.start_at<>OLD.start_at OR NEW.end_at<>OLD.end_at OR NEW.status<>OLD.status THEN
    -- Reschedules re-check hours/day-off/eligibility; any status change into a live state re-checks overlap.
    IF NEW.staff_id<>OLD.staff_id OR NEW.date<>OLD.date OR NEW.start_at<>OLD.start_at OR NEW.end_at<>OLD.end_at THEN
      PERFORM ollo_booking_slot_checks(NEW);
    ELSIF NEW.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED') AND EXISTS (
      SELECT 1 FROM bookings x WHERE x.shop_id=NEW.shop_id AND x.staff_id=NEW.staff_id AND x.id<>NEW.id
        AND x.status IN ('CONFIRMED','CHECKED_IN','IN_SERVICE','COMPLETED')
        AND x.start_at < NEW.end_at + NEW.buffer_min * 60000 AND NEW.start_at < x.end_at + x.buffer_min * 60000
    ) THEN PERFORM ollo_abort('slot_taken'); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_booking_update BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION ollo_validate_booking_update();

-- Per-shop booking sequence without MAX()+1 races: an advisory lock on the shop id.
CREATE OR REPLACE FUNCTION ollo_lock_shop(shop TEXT) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtext(shop)) $$;
