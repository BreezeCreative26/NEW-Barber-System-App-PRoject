-- Deposits collected online through the shop's own Stripe account (Model A: OLLO never holds funds).
-- Shop: connected account + whether deposits are taken online + how long an unpaid hold lasts.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS stripe_account_id TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS deposits_online INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS deposit_hold_min INTEGER NOT NULL DEFAULT 15;
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_deposits_check;
ALTER TABLE shops ADD CONSTRAINT shops_deposits_check CHECK (deposits_online IN (0,1) AND deposit_hold_min BETWEEN 5 AND 120);

-- Booking: deposit lifecycle. NONE (no online deposit), PENDING (slot held, awaiting card),
-- PAID, REFUNDED, EXPIRED (hold lapsed, booking cancelled). Not part of the immutable snapshot.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_status TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_hold_until BIGINT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_deposit_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_deposit_status_check CHECK (deposit_status IN ('NONE','PENDING','PAID','REFUNDED','EXPIRED'));
CREATE INDEX IF NOT EXISTS bookings_deposit_holds ON bookings(deposit_status, deposit_hold_until) WHERE deposit_status='PENDING';
CREATE INDEX IF NOT EXISTS bookings_stripe_session ON bookings(stripe_session_id) WHERE stripe_session_id<>'';

-- Ledger: a deposit paid online lands in the till as method ONLINE when the visit is checked out.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK(method IN ('CARD','CASH','TRANSFER','VOUCHER','ONLINE'));

-- Stripe webhook events we have already handled (idempotency).
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at BIGINT NOT NULL
);
