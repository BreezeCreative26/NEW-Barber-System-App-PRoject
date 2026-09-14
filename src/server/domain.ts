import { z } from "zod";

export type Shop = {
  id: string;
  name: string;
  address: string;
  timezone: string;
  opens: number;
  closes: number;
  closed_days: string;
  deposit_pence: number;
  cancel_hours: number;
  no_show_grace: number;
  version: number;
};
export type Staff = {
  id: string;
  shop_id: string;
  name: string;
  role: string;
  active: number;
  version: number;
};
export type Service = {
  id: string;
  shop_id: string;
  name: string;
  category: string;
  duration_min: number;
  price_pence: number;
  active: number;
  version: number;
};
export type Hours = {
  shop_id: string;
  staff_id: string;
  weekday: number;
  enabled: number;
  starts: number;
  ends: number;
  break_start: number;
  break_end: number;
};
export type Holiday = {
  id: string;
  shop_id: string;
  date: string;
  label: string;
};
export type StoredBooking = {
  id: string;
  shop_id: string;
  sequence: number;
  request_id: string;
  request_hash: string;
  staff_id: string;
  service_id: string;
  customer_name: string;
  phone: string;
  notes: string;
  date: string;
  start_min: number;
  start_at: number;
  end_at: number;
  duration_min: number;
  buffer_min: number;
  service_name: string;
  price_pence: number;
  deposit_policy_pence: number;
  cancel_hours_snapshot: number;
  source: string;
  status: string;
  version: number;
  created_at: number;
  updated_at: number;
};
export type AuditEvent = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  reason: string;
  created_at: number;
};
export type WorkspaceData = {
  shop: Shop;
  staff: Staff[];
  services: Service[];
  hours: Hours[];
  holidays: Holiday[];
  bookings: StoredBooking[];
  audit: AuditEvent[];
  today: string;
  now: number;
  mode: "sandbox";
  issues: { booking_id: string; ref: string; reason: string }[];
};

const name = z.string().trim().min(2).max(100);
const active = z.number().int().min(0).max(1);
const version = z.number().int().min(0);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T12:00:00Z`);
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }, "Invalid calendar date");
export const staffSchema = z
  .object({
    name,
    role: z.string().trim().min(2).max(50),
    active: active.default(1),
    version: version.optional(),
  })
  .strict();
export const serviceSchema = z
  .object({
    name,
    category: z.string().trim().min(2).max(40),
    duration_min: z.number().int().min(5).max(240),
    price_pence: z.number().int().min(0).max(100000),
    active: active.default(1),
    version: version.optional(),
  })
  .strict();
export const shopSchema = z
  .object({
    name,
    address: z.string().trim().max(200),
    timezone: z.literal("Europe/London"),
    opens: z.number().int().min(0).max(1439),
    closes: z.number().int().min(1).max(1440),
    closed_days: z.array(z.number().int().min(0).max(6)).max(7),
    deposit_pence: z.number().int().min(0).max(10000),
    cancel_hours: z.number().int().min(0).max(168),
    no_show_grace: z.number().int().min(0).max(120),
    version,
  })
  .strict()
  .refine((s) => s.closes > s.opens, "Closing time must be after opening time");
export const hoursRowSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    enabled: active,
    starts: z.number().int().min(0).max(1439),
    ends: z.number().int().min(1).max(1440),
    break_start: z.number().int().min(0).max(1440),
    break_end: z.number().int().min(0).max(1440),
  })
  .strict()
  .refine(
    (h) =>
      h.ends > h.starts &&
      h.break_start >= h.starts &&
      h.break_end >= h.break_start &&
      h.break_end <= h.ends,
    "Shift and break times must be ordered and within the shift",
  );
export const hoursSchema = z
  .object({
    version,
    rows: z
      .array(hoursRowSchema)
      .length(7)
      .refine(
        (a) => new Set(a.map((x) => x.weekday)).size === 7,
        "Supply each weekday once",
      ),
  })
  .strict();
export const holidaySchema = z
  .object({ date: dateSchema, label: z.string().trim().min(2).max(100) })
  .strict();
export const bookingSchema = z
  .object({
    request_id: z.string().uuid(),
    staff_id: z.string().uuid(),
    service_id: z.string().uuid(),
    customer_name: name,
    phone: z
      .string()
      .transform((s) => s.replace(/[\s()-]/g, ""))
      .refine(
        (s) => /^(?:\+44|0)7\d{9}$/.test(s),
        "Enter a valid UK mobile number",
      ),
    notes: z.string().trim().max(500).default(""),
    date: dateSchema,
    start_min: z
      .number()
      .int()
      .min(0)
      .max(1425)
      .refine((v) => v % 15 === 0, "Choose a 15-minute start"),
    source: z.enum(["TEST_BOOKING", "WALK_IN"]),
    quote: z
      .object({ service_version: version, shop_version: version })
      .strict(),
  })
  .strict();
export const bookingDetailsSchema = z
  .object({
    customer_name: name,
    phone: bookingSchema.shape.phone,
    notes: z.string().trim().max(500),
    reason: z.string().trim().min(3).max(300),
    version,
  })
  .strict();
export const moveSchema = z
  .object({
    date: dateSchema,
    start_min: z
      .number()
      .int()
      .min(0)
      .max(1425)
      .refine((v) => v % 15 === 0),
    staff_id: z.string().uuid(),
    reason: z.string().trim().min(3).max(300),
    version,
  })
  .strict();
export const statusSchema = z
  .object({
    status: z.enum([
      "CHECKED_IN",
      "IN_SERVICE",
      "COMPLETED",
      "CANCELLED",
      "NO_SHOW",
    ]),
    reason: z.string().trim().max(300).default(""),
    version,
  })
  .strict();

export const ref = (b: Pick<StoredBooking, "sequence">) =>
  `BRB-${String(b.sequence).padStart(4, "0")}`;
export const weekday = (date: string) =>
  new Date(`${date}T12:00:00Z`).getUTCDay();
export function shopToday(timezone = "Europe/London", now = Date.now()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => p.find((x) => x.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
// Resolve local wall time by explicit candidates. DST gaps/folds are rejected, not guessed.
export function localInstant(
  date: string,
  minute: number,
  timezone = "Europe/London",
): number | null {
  const [y, m, d] = date.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const matches: number[] = [];
  // This slice supports Europe/London only: GMT and BST candidates cover its current offsets.
  for (const offset of [0, 60]) {
    const candidate = target - offset * 60000;
    const parts = formatter.formatToParts(candidate);
    const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    if (
      get("year") === y &&
      get("month") === m &&
      get("day") === d &&
      get("hour") === Math.floor(minute / 60) &&
      get("minute") === minute % 60
    )
      matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}
export function slotReason(
  shop: Shop,
  staff: Staff | null,
  hours: Hours | null,
  holidays: Holiday[],
  bookings: StoredBooking[],
  date: string,
  start: number,
  duration: number,
  now = Date.now(),
  excludeId?: string,
): string {
  if (!staff?.active) return "Barber unavailable";
  if (
    JSON.parse(shop.closed_days).includes(weekday(date)) ||
    holidays.some((h) => h.date === date)
  )
    return "Shop closed";
  if (!hours?.enabled) return "Barber off duty";
  if (
    start < Math.max(shop.opens, hours.starts) ||
    start + duration + 10 > Math.min(shop.closes, hours.ends)
  )
    return "Outside working hours";
  if (
    hours.break_end > hours.break_start &&
    start < hours.break_end &&
    start + duration + 10 > hours.break_start
  )
    return "Lunch break";
  const instant = localInstant(date, start, shop.timezone);
  if (instant === null) return "Ambiguous or invalid local time";
  if (instant < now) return "Time has passed";
  if (
    bookings.some(
      (b) =>
        b.id !== excludeId &&
        b.staff_id === staff.id &&
        !["CANCELLED", "NO_SHOW"].includes(b.status) &&
        instant < b.end_at + b.buffer_min * 60000 &&
        b.start_at < instant + (duration + 10) * 60000,
    )
  )
    return "Slot taken";
  return "";
}
