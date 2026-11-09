-- "Card machine" tender: a card payment taken on the shop's own reader (e.g. Revolut). Unlike cash it
-- lands in the shop's account, so a chair-rent barber is owed it rather than already holding it.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK(method IN ('CARD','CASH','TRANSFER','VOUCHER','OTHER','ONLINE','READER'));
