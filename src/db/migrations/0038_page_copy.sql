-- Website editor: owner-editable wording per section (headings, sub-lines, button labels).
-- Keys are stable ids (e.g. "next.title", "cta.button"); blank/missing = the built-in default.
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS copy_json TEXT NOT NULL DEFAULT '{}';
