-- Website editor: per-element colour overrides ({"hero.button":{"bg":"#..","fg":"#.."}, ...}) and a
-- draft copy of the page so owners can edit without touching the live page until they publish.
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS element_styles_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS draft_json TEXT;
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS draft_updated_at BIGINT;
