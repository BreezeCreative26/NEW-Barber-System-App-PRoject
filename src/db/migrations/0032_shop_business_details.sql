-- Business details surfaced in Settings → Business: the legal entity behind the shop (invoices,
-- receipts, terms), the VAT and company registration numbers where they apply, and the shop's own
-- website. All optional; blank means "not given".
ALTER TABLE shops ADD COLUMN IF NOT EXISTS legal_name TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS vat_number TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS company_number TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS website TEXT NOT NULL DEFAULT '';
