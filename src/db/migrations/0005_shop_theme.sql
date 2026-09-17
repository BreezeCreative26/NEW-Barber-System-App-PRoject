-- Shop page theme: font pairing, light/dark, corner style, hero layout. JSON so options can grow without migrations.
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS theme_json TEXT NOT NULL DEFAULT '{}';
