-- Public shop home page content. One row per shop, created lazily with sensible defaults.
-- Presentation only: nothing here affects availability, pricing or bookings.
CREATE TABLE shop_pages (
  shop_id TEXT PRIMARY KEY REFERENCES shops(id),
  strapline TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  gallery_json TEXT NOT NULL DEFAULT '[]',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  map_url TEXT NOT NULL DEFAULT '',
  transport_note TEXT NOT NULL DEFAULT '',
  policy_text TEXT NOT NULL DEFAULT '',
  sections_json TEXT NOT NULL DEFAULT '["hero","next","services","team","hours","gallery","find","policies"]',
  accent TEXT NOT NULL DEFAULT 'ollo' CHECK(accent IN ('ollo','ink','sage','clay','plum','slate')),
  published INTEGER NOT NULL DEFAULT 1 CHECK(published IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
