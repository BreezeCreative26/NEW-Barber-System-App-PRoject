-- Hand-picked recipients for a platform marketing campaign. No rows = the whole list; rows = only these people.
CREATE TABLE IF NOT EXISTS marketing_campaign_contacts (
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  PRIMARY KEY (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS marketing_campaign_contacts_contact ON marketing_campaign_contacts(contact_id);
