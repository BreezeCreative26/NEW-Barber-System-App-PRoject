-- Logo tone. Measured when a logo is uploaded (sharp: mean luminance of the opaque pixels), so the
-- app knows whether the mark is light or dark and can place it correctly on every surface without
-- the owner choosing. 'light' = mostly white/pale (never invert; give it a dark plate on white),
-- 'dark' = mostly ink (invert to white on dark surfaces), 'colour' = mixed/full-colour (never touch),
-- '' = not measured (external URL / legacy upload) → treated as before ("auto" heuristics).
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS logo_tone TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_media ADD COLUMN IF NOT EXISTS tone TEXT NOT NULL DEFAULT '';

-- Shop booking terms. The owner writes their own T&Cs / booking rules; every save bumps the
-- version. A customer accepts a specific version when they sign up or book; when the terms move
-- on, the next booking asks them to accept again before it can be confirmed.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS terms_text TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS terms_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS terms_updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE customer_account_links ADD COLUMN IF NOT EXISTS terms_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_account_links ADD COLUMN IF NOT EXISTS terms_accepted_at BIGINT NOT NULL DEFAULT 0;
