-- Customer accounts: optional, passwordless, phone-first. One global identity per verified
-- mobile; each shop still owns its `customers` row, linked by phone at sign-in time.
-- Codes are never sent from the sandbox: they are returned to the page and written to audit.
CREATE TABLE customer_accounts (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

-- One-time codes: hashed, short-lived, attempt-limited. One live code per shop + phone.
CREATE TABLE customer_otp (
  shop_id TEXT NOT NULL REFERENCES shops(id),
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (shop_id, phone)
);

-- Sessions are scoped to the shop the customer signed in on; a shop never sees another shop's history.
CREATE TABLE customer_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX customer_sessions_account ON customer_sessions(account_id, shop_id);

-- Which shop `customers` row an account maps to (kept explicit so merges/phone changes stay traceable).
CREATE TABLE customer_account_links (
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  shop_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, shop_id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id)
);
CREATE INDEX customer_account_links_customer ON customer_account_links(shop_id, customer_id);
