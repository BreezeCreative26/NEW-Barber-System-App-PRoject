-- Book for someone else: the visit is for `attendee_name` while customer_name/phone stay the person
-- who booked (their customer record, manage link and account keep working). Empty = booked for self.
ALTER TABLE bookings ADD COLUMN attendee_name TEXT NOT NULL DEFAULT '';

-- Group bookings: several visits made together (father + son, mates before a wedding). Same
-- customer, same day, shared group_id; every visit is still its own row under every existing guard.
ALTER TABLE bookings ADD COLUMN group_id TEXT;
CREATE INDEX booking_group_lookup ON bookings(shop_id, group_id);
CREATE TRIGGER immutable_booking_group BEFORE UPDATE OF group_id ON bookings
WHEN OLD.group_id IS NOT NULL AND NEW.group_id IS NOT OLD.group_id
BEGIN SELECT RAISE(ABORT,'booking_group_immutable'); END;
