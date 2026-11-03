-- Texts are something each shop switches on (and pays for), and each customer says yes or no to.
--
-- 1. Which kinds of text a shop sends. Existing shops keep everything they already send; a new shop
--    picks when it switches texts on. Marketing texts have their own confirmation and are not in here.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_sms_kinds TEXT NOT NULL DEFAULT 'confirm,reminder,change,waitlist,review';

-- 2. Whether, and when, this customer was asked "text reminders yes or no" at this shop. Empty means
--    they have never been asked, so the next time they sign in with texts on, they are asked.
--    A STOP reply is remembered per shop customer, with the date, so the account can say so.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sms_choice_at BIGINT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sms_stopped_at BIGINT;
-- Everyone who already has an online account at a shop was shown the text tickbox when they signed up.
UPDATE customers c SET sms_choice_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
 WHERE sms_choice_at IS NULL AND EXISTS (SELECT 1 FROM customer_account_links l WHERE l.shop_id = c.shop_id AND l.customer_id = c.id);

-- 3. A STOP reply ends texts from the shop that sent the text, not from every shop. Each shop texts
--    under its own name, so the same person at another shop is a different relationship.
CREATE TABLE IF NOT EXISTS shop_sms_optouts (
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, phone)
);

-- 4. Customer replies to emails go to the shop's own address. A shop that never set one gets its
--    owner's sign-in email (editable in Settings > Messages), so replies never land in foliyo's inbox.
UPDATE shops s SET msg_reply_to = u.email
  FROM shop_owners o JOIN app_users u ON u.id = o.user_id
 WHERE o.shop_id = s.id AND s.msg_reply_to = '' AND u.email <> '';
