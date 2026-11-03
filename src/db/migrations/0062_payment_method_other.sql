-- "Other" is a hand-logged tender for shops that cannot take cards through foliyo (vouchers from a
-- third party, a card machine of their own, anything that is not cash or a bank transfer). Like cash it
-- never touches foliyo's balance, so pay runs treat it as money already in someone's hand.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK(method IN ('CARD','CASH','TRANSFER','VOUCHER','OTHER','ONLINE'));
