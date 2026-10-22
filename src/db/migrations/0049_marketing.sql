-- Platform marketing: prospect contacts (from CSV), campaigns, per-contact sends. Separate from shop messaging.
CREATE TABLE IF NOT EXISTS marketing_contacts (
  id TEXT PRIMARY KEY,
  list_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  business TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  landline TEXT NOT NULL DEFAULT '',
  basis TEXT NOT NULL DEFAULT '',
  unsub_token TEXT NOT NULL,
  unsubscribed_at BIGINT,
  unsub_reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_contacts_phone ON marketing_contacts(phone) WHERE phone <> '';
CREATE UNIQUE INDEX IF NOT EXISTS marketing_contacts_email ON marketing_contacts(LOWER(email)) WHERE email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS marketing_contacts_token ON marketing_contacts(unsub_token);
CREATE INDEX IF NOT EXISTS marketing_contacts_list ON marketing_contacts(list_name);
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'BOTH' CHECK (channel IN ('SMS','EMAIL','BOTH')),
  list_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  heading TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sms_body TEXT NOT NULL DEFAULT '',
  cta_label TEXT NOT NULL DEFAULT 'Start free',
  cta_url TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENDING','DONE','PAUSED')),
  consent_confirmed_by TEXT NOT NULL DEFAULT '',
  consent_confirmed_at BIGINT,
  recipients INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT
);
CREATE TABLE IF NOT EXISTS marketing_sends (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('SMS','EMAIL')),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','SKIPPED')),
  error TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  sent_at BIGINT,
  UNIQUE (campaign_id, contact_id, channel)
);
CREATE INDEX IF NOT EXISTS marketing_sends_queue ON marketing_sends(campaign_id, status);
