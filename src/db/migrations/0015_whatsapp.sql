-- WhatsApp as a third channel (Infobip, one OLLO sender shared by all shops).
-- notifications.channel gains WA; customers may prefer WA (opt-in at booking or in their account);
-- shops can switch WA off; inbound replies are stored so a shop can see what a customer said.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check CHECK (channel IN ('SMS','EMAIL','WA'));
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_contact_pref_check;
ALTER TABLE customers ADD CONSTRAINT customers_contact_pref_check CHECK (contact_pref IN ('AUTO','SMS','WA','EMAIL','NONE'));
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_wa INTEGER NOT NULL DEFAULT 1;
-- The customer's channel choice is captured on the booking too (they may not have a customers row yet).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS contact_pref TEXT NOT NULL DEFAULT 'AUTO';
-- WhatsApp opt-outs: a STOP (or Meta-level block) for a phone number, platform-wide.
CREATE TABLE IF NOT EXISTS wa_optouts (
  phone TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
-- Inbound WhatsApp messages (customer replies). Matched to a shop by the most recent outbound
-- message to that phone; shown in the outbox with direction IN.
CREATE TABLE IF NOT EXISTS wa_inbound (
  id TEXT PRIMARY KEY,
  shop_id TEXT,
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  received_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_inbound_shop ON wa_inbound(shop_id, received_at);
