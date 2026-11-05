-- Team bell clean-up, per login: which activity items this person has read one by one or cleared,
-- and which "needs attention" items they dismissed. item_key is 'read:<event id>', 'clear:<event id>'
-- or 'dismiss:<booking id>|<reason>' (a new reason for the same booking shows again). Nothing here
-- deletes the shared shop_events rows, so clearing only tidies that person's bell.
CREATE TABLE IF NOT EXISTS shop_bell_marks (
  shop_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, viewer_id, item_key)
);
CREATE INDEX IF NOT EXISTS shop_bell_marks_at ON shop_bell_marks(shop_id, viewer_id, at);
