-- Payment is one shop-wide choice (online payments, or pay in store). Per-service overrides are retired.
UPDATE services SET payment_mode = NULL WHERE payment_mode IS NOT NULL;
