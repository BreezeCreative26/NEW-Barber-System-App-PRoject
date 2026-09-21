-- Rebrand OLLO → foliyo in seeded names. Env vars / cookies keep their names.
UPDATE plans SET name = 'foliyo' WHERE id = 'core' AND name = 'OLLO';
UPDATE platform_billing SET
  company_name = CASE WHEN company_name = 'OLLO' THEN 'foliyo' ELSE company_name END,
  invoice_prefix = CASE WHEN invoice_prefix = 'OLLO-' THEN 'FOL-' ELSE invoice_prefix END,
  invoice_footer = CASE WHEN invoice_footer = 'Thank you for running your shop on OLLO.' THEN 'Thank you for running your shop on foliyo.' ELSE invoice_footer END
WHERE id = 1;
ALTER TABLE platform_billing ALTER COLUMN invoice_prefix SET DEFAULT 'FOL-';
ALTER TABLE platform_billing ALTER COLUMN company_name SET DEFAULT 'foliyo';
ALTER TABLE platform_billing ALTER COLUMN invoice_footer SET DEFAULT 'Thank you for running your shop on foliyo.';
