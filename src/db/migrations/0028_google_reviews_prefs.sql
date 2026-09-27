-- Google reviews: the shop's public "write a review" link (Google Business Profile short link,
-- e.g. https://g.page/r/<id>/review). Shown to customers after they leave a 4–5★ rating in-app,
-- optionally texted as a follow-up, and linked from the shop page footer.
ALTER TABLE shop_pages ADD COLUMN IF NOT EXISTS google_review_url TEXT NOT NULL DEFAULT '';
-- Ask for a Google review by text after a good in-app rating (0/1). Off by default: the owner
-- turns it on once the link is set.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS google_review_nudge INTEGER NOT NULL DEFAULT 0;
