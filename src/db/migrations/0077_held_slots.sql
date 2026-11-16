-- "Hold a space": a barber keeps a time for a named customer and sends them a link to confirm.
-- The hold is a waiting-list offer (source HOLD) plus a calendar block tied to it, so nobody else
-- can book the time while it is held. The block goes when the offer is accepted, declined or lapses.
ALTER TABLE staff_blocks ADD COLUMN IF NOT EXISTS offer_id TEXT;
CREATE INDEX IF NOT EXISTS staff_blocks_offer ON staff_blocks(offer_id) WHERE offer_id IS NOT NULL;
ALTER TABLE waitlist_offers DROP CONSTRAINT IF EXISTS waitlist_offers_source_check;
ALTER TABLE waitlist_offers ADD CONSTRAINT waitlist_offers_source_check CHECK (source IN ('MANUAL','AUTO','HOLD'));
