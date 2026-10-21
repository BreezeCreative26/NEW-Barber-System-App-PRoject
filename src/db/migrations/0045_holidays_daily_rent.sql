-- Holiday allowance and tracker, plus daily chair rent.
--   staff_days_off.kind     what the day off is: HOLIDAY counts against the allowance; SICK, UNPAID
--                           and OTHER are recorded but don't use it up.
--   staff.holiday_allowance_x2 / holiday_carry_x2
--                           allowance for the leave year and days carried over, in half days
--                           (56 = 28 days). 0 means "not set" — days off are still tracked.
--   shops.leave_year_start  MM-DD the leave year starts on (default 1 January).
ALTER TABLE staff_days_off ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'HOLIDAY';
ALTER TABLE staff_days_off DROP CONSTRAINT IF EXISTS staff_days_off_kind_check;
ALTER TABLE staff_days_off ADD CONSTRAINT staff_days_off_kind_check CHECK (kind IN ('HOLIDAY','SICK','UNPAID','OTHER'));
UPDATE staff_days_off SET kind = 'SICK' WHERE kind = 'HOLIDAY' AND reason ILIKE '%sick%';
ALTER TABLE staff ADD COLUMN IF NOT EXISTS holiday_allowance_x2 integer NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS holiday_carry_x2 integer NOT NULL DEFAULT 0;
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_holiday_allowance_check;
ALTER TABLE staff ADD CONSTRAINT staff_holiday_allowance_check CHECK (holiday_allowance_x2 >= 0 AND holiday_allowance_x2 <= 730 AND holiday_carry_x2 >= 0 AND holiday_carry_x2 <= 730);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS leave_year_start text NOT NULL DEFAULT '01-01';
