-- Shop-controlled buffer between appointments (was hard-coded to 10 minutes).
ALTER TABLE shops ADD COLUMN IF NOT EXISTS buffer_min INTEGER NOT NULL DEFAULT 10 CHECK (buffer_min BETWEEN 0 AND 60 AND buffer_min % 5 = 0);
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_buffer_min_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_buffer_min_check CHECK (buffer_min BETWEEN 0 AND 60);
