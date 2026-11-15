-- One-time customer pop-ups, remembered per person (not per device):
--   install_prompt_at: when they were shown "add the shop app to your home screen" (NULL = never)
--   review_prompt_booking: the visit whose review pop-up they dismissed with "Not now"
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS install_prompt_at BIGINT;
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS review_prompt_booking TEXT;
