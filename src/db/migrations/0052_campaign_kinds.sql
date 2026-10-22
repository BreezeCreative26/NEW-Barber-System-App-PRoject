-- Shop campaigns: a type (launch, offer, quiet days, win-back, hours, new service, custom),
-- more audiences (recent and lapsed customers) and an optional send time.
ALTER TABLE shop_campaigns ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'launch';
ALTER TABLE shop_campaigns ADD COLUMN IF NOT EXISTS scheduled_for BIGINT NOT NULL DEFAULT 0;
ALTER TABLE shop_campaigns DROP CONSTRAINT IF EXISTS shop_campaigns_audience_check;
ALTER TABLE shop_campaigns ADD CONSTRAINT shop_campaigns_audience_check CHECK (audience IN ('ALL','OPTED_IN','RECENT','LAPSED'));
