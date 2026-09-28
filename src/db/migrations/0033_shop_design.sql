-- Website builder. Each shop can override the palette with its own primary / secondary colours
-- (hex, blank = use the named accent) and choose a layout variant per section (JSON map
-- section → variant, e.g. {"hero":"cover","team":"portraits","reviews":"wall"}). Variants are
-- rendered as classes on the shop page and auto-adapt to the viewport.
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS primary_hex TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS secondary_hex TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS variants_json TEXT NOT NULL DEFAULT '{}';
