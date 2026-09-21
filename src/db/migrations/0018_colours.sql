-- Wider colour palette for services and barbers; shop chooses whether calendar cards take the
-- barber's colour or the service's.
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_colour_check;
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_colour_check;
ALTER TABLE services ADD CONSTRAINT services_colour_check CHECK (colour IN ('sage','sand','blue','clay','plum','slate','mint','coral','gold','teal','rose','ink'));
ALTER TABLE staff ADD CONSTRAINT staff_colour_check CHECK (colour IN ('sage','sand','blue','clay','plum','slate','mint','coral','gold','teal','rose','ink'));
ALTER TABLE shops ADD COLUMN IF NOT EXISTS card_colour TEXT NOT NULL DEFAULT 'BARBER' CHECK (card_colour IN ('BARBER','SERVICE'));
