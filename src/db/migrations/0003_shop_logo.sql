-- Shop logo, uploaded through the media pipeline (kind 'logo') and shown on the shop page, booking flow and workspace.
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT '';
