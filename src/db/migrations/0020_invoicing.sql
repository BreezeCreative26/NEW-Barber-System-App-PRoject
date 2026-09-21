-- Invoicing that works with or without Stripe: monthly period close, manual invoices, credit notes,
-- refunds, payment marking, printable copies, plus shop lifecycle (suspend / owner links).

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'PERIOD' CHECK (kind IN ('PERIOD','MANUAL','CREDIT_NOTE'));
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credit_note_for TEXT REFERENCES invoices(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_key TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_at BIGINT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_by TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at BIGINT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_to TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_via TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS voided_at BIGINT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS void_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credit_applied_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_to_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS view_token TEXT NOT NULL DEFAULT '';
-- One period invoice per shop per month.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_shop_period ON invoices (shop_id, period_key) WHERE kind = 'PERIOD' AND status <> 'VOID';
CREATE INDEX IF NOT EXISTS invoices_status ON invoices (status, due_at);

-- Sequential numbers. Credit notes share the sequence with a CN prefix.
CREATE TABLE IF NOT EXISTS invoice_counters (
  key TEXT PRIMARY KEY,
  next INTEGER NOT NULL DEFAULT 1
);
INSERT INTO invoice_counters(key, next) VALUES ('invoice', 1001), ('credit_note', 1) ON CONFLICT (key) DO NOTHING;

-- Adjustments can now be refunds, and are stamped with the invoice they were applied to.
ALTER TABLE invoice_adjustments DROP CONSTRAINT IF EXISTS invoice_adjustments_kind_check;
ALTER TABLE invoice_adjustments ADD CONSTRAINT invoice_adjustments_kind_check CHECK (kind IN ('CREDIT','CHARGE','REFUND'));
ALTER TABLE invoice_adjustments ADD COLUMN IF NOT EXISTS applied_at BIGINT;
ALTER TABLE invoice_adjustments ADD COLUMN IF NOT EXISTS refund_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE invoice_adjustments ADD COLUMN IF NOT EXISTS refund_via TEXT NOT NULL DEFAULT '';

-- Invoice-issuing company details + terms (shown on every invoice).
ALTER TABLE platform_billing ADD COLUMN IF NOT EXISTS invoice_prefix TEXT NOT NULL DEFAULT 'OLLO-';
ALTER TABLE platform_billing ADD COLUMN IF NOT EXISTS due_days INTEGER NOT NULL DEFAULT 7 CHECK (due_days BETWEEN 0 AND 60);
ALTER TABLE platform_billing ADD COLUMN IF NOT EXISTS company_name TEXT NOT NULL DEFAULT 'OLLO';
ALTER TABLE platform_billing ADD COLUMN IF NOT EXISTS company_address TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_billing ADD COLUMN IF NOT EXISTS company_email TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_billing ADD COLUMN IF NOT EXISTS company_number TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_billing ADD COLUMN IF NOT EXISTS bank_details TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_billing ADD COLUMN IF NOT EXISTS invoice_footer TEXT NOT NULL DEFAULT 'Thank you for running your shop on OLLO.';
ALTER TABLE platform_billing ADD COLUMN IF NOT EXISTS last_period_close TEXT NOT NULL DEFAULT '';

-- Shop lifecycle: suspension is separate from the subscription (fraud / abuse / non-payment hold).
ALTER TABLE shops ADD COLUMN IF NOT EXISTS suspended_at BIGINT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS suspended_reason TEXT NOT NULL DEFAULT '';

-- One-time sign-in links an admin can send a locked-out owner (15 minutes, single use).
CREATE TABLE IF NOT EXISTS owner_links (
  token_hash TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL REFERENCES app_memberships(id),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
