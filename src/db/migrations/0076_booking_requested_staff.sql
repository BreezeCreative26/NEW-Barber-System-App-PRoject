-- The customer picked this barber themselves (online, in a shop with more than one barber), rather
-- than "anyone available". Shown on the calendar as "Asked for this barber".
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS requested_staff INTEGER NOT NULL DEFAULT 0;
