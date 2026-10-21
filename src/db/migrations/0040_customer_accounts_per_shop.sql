-- Customer accounts belong to ONE shop.
--
-- Before: customer_accounts was global (one person, one login for every shop on foliyo), so a
-- password, an email and a mobile were shared across unrelated businesses. Now each shop has its
-- own accounts: the same person at two shops has two accounts that never see each other.
--
-- Existing data: an account linked to several shops is split into one copy per shop. Sessions,
-- reset links, push subscriptions and links move to the copy for their own shop. An account that
-- no shop can claim (no link, session, reset or push row) is removed.
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS shop_id TEXT REFERENCES shops(id);

-- Every (account, shop) pair that has any footprint.
CREATE TEMP TABLE _acct_shops ON COMMIT DROP AS
  SELECT account_id, shop_id, MIN(first_at) AS first_at FROM (
    SELECT account_id, shop_id, linked_at AS first_at FROM customer_account_links
    UNION ALL SELECT account_id, shop_id, created_at FROM customer_sessions
    UNION ALL SELECT account_id, shop_id, created_at FROM customer_reset_tokens
    UNION ALL SELECT account_id, shop_id, created_at FROM customer_push_subscriptions
  ) u GROUP BY account_id, shop_id;

-- The earliest shop keeps the original row (and id); later shops get copies.
CREATE TEMP TABLE _acct_rank ON COMMIT DROP AS
  SELECT account_id, shop_id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY first_at, shop_id) AS rn FROM _acct_shops;

UPDATE customer_accounts a SET shop_id = r.shop_id FROM _acct_rank r WHERE r.account_id = a.id AND r.rn = 1;

-- Phone and email were unique platform-wide; drop that before inserting the per-shop copies.
ALTER TABLE customer_accounts DROP CONSTRAINT IF EXISTS customer_accounts_phone_key;
DROP INDEX IF EXISTS customer_accounts_email;

INSERT INTO customer_accounts(id, shop_id, phone, email, name, created_at, last_seen_at, version, password_hash, password_salt, email_verified, password_set_at)
  SELECT md5(a.id || ':' || r.shop_id), r.shop_id, a.phone, a.email, a.name, a.created_at, a.last_seen_at, a.version, a.password_hash, a.password_salt, a.email_verified, a.password_set_at
  FROM _acct_rank r JOIN customer_accounts a ON a.id = r.account_id WHERE r.rn > 1;

-- Point each dependent row at the account that belongs to its shop.
UPDATE customer_account_links x SET account_id = md5(x.account_id || ':' || x.shop_id)
  FROM _acct_rank r WHERE r.account_id = x.account_id AND r.shop_id = x.shop_id AND r.rn > 1;
UPDATE customer_sessions x SET account_id = md5(x.account_id || ':' || x.shop_id)
  FROM _acct_rank r WHERE r.account_id = x.account_id AND r.shop_id = x.shop_id AND r.rn > 1;
UPDATE customer_reset_tokens x SET account_id = md5(x.account_id || ':' || x.shop_id)
  FROM _acct_rank r WHERE r.account_id = x.account_id AND r.shop_id = x.shop_id AND r.rn > 1;
UPDATE customer_push_subscriptions x SET account_id = md5(x.account_id || ':' || x.shop_id)
  FROM _acct_rank r WHERE r.account_id = x.account_id AND r.shop_id = x.shop_id AND r.rn > 1;

-- Accounts nobody can claim.
DELETE FROM customer_accounts WHERE shop_id IS NULL;
ALTER TABLE customer_accounts ALTER COLUMN shop_id SET NOT NULL;

-- Unique within a shop only.
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_shop_phone ON customer_accounts(shop_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_shop_email ON customer_accounts(shop_id, lower(email)) WHERE email <> '';
CREATE INDEX IF NOT EXISTS customer_accounts_shop ON customer_accounts(shop_id);

-- A row can only ever reference an account of its own shop.
ALTER TABLE customer_accounts ADD CONSTRAINT customer_accounts_id_shop UNIQUE (id, shop_id);
ALTER TABLE customer_sessions ADD CONSTRAINT customer_sessions_account_shop FOREIGN KEY (account_id, shop_id) REFERENCES customer_accounts(id, shop_id);
ALTER TABLE customer_reset_tokens ADD CONSTRAINT customer_reset_tokens_account_shop FOREIGN KEY (account_id, shop_id) REFERENCES customer_accounts(id, shop_id);
ALTER TABLE customer_push_subscriptions ADD CONSTRAINT customer_push_account_shop FOREIGN KEY (account_id, shop_id) REFERENCES customer_accounts(id, shop_id);
ALTER TABLE customer_account_links ADD CONSTRAINT customer_account_links_account_shop FOREIGN KEY (account_id, shop_id) REFERENCES customer_accounts(id, shop_id);
