-- A shop's own web address (e.g. book.northline.co.uk): customers book there and emails come from
-- bookings@<that address>. One per shop. Both halves are verified separately: the web address
-- (Vercel) and the email sender (Resend). Until a half is VERIFIED, the foliyo address and sender
-- keep being used, so nothing breaks while DNS catches up.
CREATE TABLE IF NOT EXISTS shop_domains (
  shop_id TEXT PRIMARY KEY REFERENCES shops(id),
  domain TEXT NOT NULL UNIQUE,
  web_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (web_status IN ('PENDING','VERIFIED','ERROR')),
  mail_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (mail_status IN ('PENDING','VERIFIED','ERROR')),
  resend_domain_id TEXT NOT NULL DEFAULT '',
  records_json TEXT NOT NULL DEFAULT '[]',
  last_checked_at BIGINT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Off by default: foliyo (or a paid plan later) switches it on per shop. Vercel and Resend both cap
-- how many domains an account can hold, so this stays a deliberate grant.
INSERT INTO features (key, name, description, kind, monthly_pence, unit, unit_pence, included_units, in_plan, sort, updated_at) VALUES
  ('custom_domain', 'Your own web address', 'Booking site and customer emails on the shop''s own domain.', 'FLAG', 0, '', 0, 0, 0, 80, 0)
ON CONFLICT (key) DO NOTHING;
