-- A deposit refund Stripe refused (network, balance, dashboard-side state) must not be left to luck:
-- remember that one is owed and when to try again. NULL = nothing owed.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_refund_retry_at BIGINT;
CREATE INDEX IF NOT EXISTS bookings_refund_retry ON bookings(deposit_refund_retry_at) WHERE deposit_refund_retry_at IS NOT NULL;
