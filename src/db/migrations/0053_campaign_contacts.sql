-- People a shop uploads from a CSV to add to a campaign. Kept separate from the customer list.
CREATE TABLE IF NOT EXISTS shop_campaign_contacts (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  unsub_token TEXT NOT NULL,
  unsub_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_campaign_contacts_token ON shop_campaign_contacts(unsub_token);
CREATE UNIQUE INDEX IF NOT EXISTS shop_campaign_contacts_phone ON shop_campaign_contacts(shop_id, phone) WHERE phone<>'';
CREATE UNIQUE INDEX IF NOT EXISTS shop_campaign_contacts_email ON shop_campaign_contacts(shop_id, email) WHERE email<>'';
ALTER TABLE shop_campaigns DROP CONSTRAINT IF EXISTS shop_campaigns_audience_check;
ALTER TABLE shop_campaigns ADD CONSTRAINT shop_campaigns_audience_check CHECK (audience IN ('ALL','OPTED_IN','RECENT','LAPSED','NONE'));
