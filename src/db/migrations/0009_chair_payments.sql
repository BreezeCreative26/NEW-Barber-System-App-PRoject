-- Card at the chair. A payment request is a Checkout session (pay-by-link / QR) or a Terminal
-- PaymentIntent for a visit; when Stripe confirms, the ledger row is written with the Stripe refs so
-- the pay run treats it as card money on the platform.
CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  booking_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('LINK','TERMINAL')),
  service_pence INTEGER NOT NULL CHECK(service_pence >= 0),
  tip_pence INTEGER NOT NULL DEFAULT 0 CHECK(tip_pence >= 0),
  discount_pence INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  stripe_session_id TEXT NOT NULL DEFAULT '',
  stripe_payment_intent TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','PAID','EXPIRED','CANCELLED')),
  payment_id TEXT,                      -- ledger row once paid
  sent_to TEXT NOT NULL DEFAULT '',     -- phone/email the link was sent to, if any
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  paid_at BIGINT,
  FOREIGN KEY(shop_id,booking_id) REFERENCES bookings(shop_id,id)
);
CREATE INDEX IF NOT EXISTS payment_requests_booking ON payment_requests(shop_id, booking_id, created_at);
CREATE INDEX IF NOT EXISTS payment_requests_open ON payment_requests(status, expires_at) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS payment_requests_session ON payment_requests(stripe_session_id) WHERE stripe_session_id<>'';

-- Terminal readers registered to a shop (Tap to Pay on phone registers as a reader too).
CREATE TABLE IF NOT EXISTS terminal_readers (
  id TEXT PRIMARY KEY,                  -- tmr_…
  shop_id TEXT NOT NULL REFERENCES shops(id),
  label TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT '',
  location_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offline',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS stripe_location_id TEXT NOT NULL DEFAULT '';
