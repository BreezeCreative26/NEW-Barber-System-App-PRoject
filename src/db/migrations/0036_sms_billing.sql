-- Texts are a metered, invoiceable unit. Price set to 8p per text (Telnyx cost ~4p; covers
-- multi-segment messages, number rental and support). WhatsApp stays at 3p.
UPDATE features SET unit_pence = 8, description = 'Confirmations, reminders and codes by text. Billed per text sent, itemised on your invoice.', updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint WHERE key = 'sms' AND unit_pence = 6;

-- The owner explicitly acknowledged that texts are billed (set at onboarding / Settings → Messages).
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_sms_billing_ack_at BIGINT;
-- Shops that already have texts switched on and have sent real texts are treated as acknowledged.
UPDATE shops s SET msg_sms_billing_ack_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
WHERE msg_sms_billing_ack_at IS NULL AND msg_sms = 1 AND EXISTS (SELECT 1 FROM usage_events u WHERE u.shop_id = s.id AND u.feature_key = 'sms');

-- Statement / invoice branding: nothing new on shops (logo_url + primary colour already live on shop_pages).
