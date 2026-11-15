-- Short links for texts. A long link (a guest's manage link is ~100 characters) makes a text two or
-- three parts, each billed by the provider. Links over 45 characters are swapped at send time for
-- <shop address>/s/<code>, which redirects to the stored URL. Codes are 8 random-looking base62
-- characters derived from the message and URL, so a retry reuses the same code.
CREATE TABLE IF NOT EXISTS sms_links (
  code TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
