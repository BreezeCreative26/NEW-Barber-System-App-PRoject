import { z } from "zod";

export type Shop = {
  id: string;
  name: string;
  address: string;
  timezone: string;
  currency: string;
  opens: number;
  closes: number;
  closed_days: string;
  week_json: string;
  deposit_pence: number;
  cancel_hours: number;
  no_show_grace: number;
  slug: string | null;
  online_booking: number;
  lead_time_min: number;
  booking_window_days: number;
  till_access: "OWNER" | "ALL";
  version: number;
};
export type ShopDay = { enabled: 0 | 1; starts: number; ends: number };
const DEFAULT_WEEK: ShopDay[] = Array.from({ length: 7 }, (_, wd) => ({ enabled: wd === 0 ? 0 : 1, starts: 540, ends: 1080 }));
// Per-weekday shop hours. Falls back to the legacy opens/closes/closed_days when week_json is absent
// (older rows, unit fixtures) so every caller can rely on a full 7-entry array.
export function shopWeek(shop: Pick<Shop, "opens" | "closes" | "closed_days"> & { week_json?: string | null }): ShopDay[] {
  try {
    const parsed = shop.week_json ? (JSON.parse(shop.week_json) as ShopDay[]) : null;
    if (parsed && parsed.length === 7) return parsed.map((d) => ({ enabled: d.enabled ? 1 : 0, starts: d.starts, ends: d.ends }));
  } catch {
    /* fall through */
  }
  const closed = new Set<number>(JSON.parse(shop.closed_days || "[]"));
  return DEFAULT_WEEK.map((_, wd) => ({ enabled: closed.has(wd) ? 0 : 1, starts: shop.opens, ends: shop.closes }));
}
export const shopDay = (shop: Parameters<typeof shopWeek>[0], wd: number): ShopDay => shopWeek(shop)[wd];
// 15-minute start candidates within the shop's hours on a given date (empty when the shop is shut).
export function dayStarts(shop: Parameters<typeof shopWeek>[0], date: string): number[] {
  const d = shopDay(shop, weekday(date));
  if (!d.enabled) return [];
  const out: number[] = [];
  for (let m = Math.ceil(d.starts / 15) * 15; m < d.ends; m += 15) out.push(m);
  return out;
}
// Legacy columns derived from the week: earliest open, latest close, disabled weekdays.
export function weekEnvelope(week: ShopDay[]) {
  const open = week.filter((d) => d.enabled);
  return {
    opens: open.length ? Math.min(...open.map((d) => d.starts)) : 540,
    closes: open.length ? Math.max(...open.map((d) => d.ends)) : 1080,
    closed_days: week.map((d, i) => (d.enabled ? -1 : i)).filter((i) => i >= 0),
  };
}
export type PayModel = "COMMISSION" | "CHAIR_RENT" | "HOURLY" | "SALARY" | "HYBRID";
export type PayPeriod = "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";
export type PayTerms = {
  pay_model: PayModel;
  pay_period: PayPeriod;
  commission_pct: number;
  base_pence: number;
  hourly_pence: number;
  rent_pence: number;
  commission_threshold_pence: number;
  commission_tiers: { from_pence: number; pct: number }[];
  tip_share_pct: number;
  product_commission_pct: number;
  employment: "SELF_EMPLOYED" | "EMPLOYED";
  pay_notes: string;
};
export type PayRun = {
  id: string;
  shop_id: string;
  staff_id: string;
  period_from: string;
  period_to: string;
  pay_model: PayModel;
  terms_json: string;
  service_pence: number;
  tips_pence: number;
  visits: number;
  hours_x100: number;
  commission_pence: number;
  base_pence: number;
  hourly_pence: number;
  tip_pence: number;
  rent_pence: number;
  adjustments_json: string;
  adjustments_pence: number;
  net_pence: number;
  status: "DRAFT" | "APPROVED" | "PAID" | "VOID";
  paid_method: string | null;
  paid_reference: string;
  note: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  version: number;
};
export type Staff = {
  id: string;
  shop_id: string;
  name: string;
  role: string;
  active: number;
  version: number;
  title: string;
  bio: string;
  colour: string;
  photo_url: string;
  online_visible: number;
  skills: string;
  instagram: string;
  start_date: string | null;
  sort_order: number;
  commission_pct: number;
  pay_model: PayModel;
  pay_period: PayPeriod;
  base_pence: number;
  hourly_pence: number;
  rent_pence: number;
  commission_threshold_pence: number;
  commission_tiers: string;
  tip_share_pct: number;
  product_commission_pct: number;
  employment: "SELF_EMPLOYED" | "EMPLOYED";
  pay_notes: string;
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
  description: string;
  colour: string;
  online_bookable: number;
  popular: number;
  sort_order: number;
};
export type Addon = {
  id: string;
  shop_id: string;
  name: string;
  price_pence: number;
  duration_min: number;
  active: number;
  version: number;
};
export type AddonLink = {
  shop_id: string;
  addon_id: string;
  service_id: string;
};
export type StaffServiceRule = {
  shop_id: string;
  staff_id: string;
  service_id: string;
  enabled: number;
  price_pence: number | null;
  duration_min: number | null;
  version: number;
};
export type ScheduleOverride = {
  id: string;
  shop_id: string;
  staff_id: string;
  date: string;
  enabled: number;
  starts: number;
  ends: number;
  break_start: number;
  break_end: number;
  reason: string;
  version: number;
};
export type BookingItem = {
  kind: "SERVICE" | "ADDON";
  id: string;
  name: string;
  price_pence: number;
  duration_min: number;
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
export type StaffDayOff = {
  id: string;
  shop_id: string;
  staff_id: string;
  date: string;
  reason: string;
  created_at: number;
};
export type StoredBooking = {
  customer_id: string | null;
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
  items_json: string;
  price_pence: number;
  deposit_policy_pence: number;
  cancel_hours_snapshot: number;
  source: string;
  channel: "OWNER" | "ONLINE";
  email: string;
  series_id: string | null;
  attendee_name: string;
  group_id: string | null;
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
  account?: import("./accounts").Account | null;
  shop: Shop;
  logo_url?: string;
  staff: Staff[];
  services: Service[];
  addons: Addon[];
  addon_links: AddonLink[];
  service_rules: StaffServiceRule[];
  schedule_overrides: ScheduleOverride[];
  hours: Hours[];
  holidays: Holiday[];
  days_off: StaffDayOff[];
  bookings: StoredBooking[];
  payments: Payment[];
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
export const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[\s()-]/g, ""))
  .refine((s) => /^(?:\+44|0)7\d{9}$/.test(s), "Enter a valid UK mobile number");
export type Customer = {
  id: string;
  shop_id: string;
  name: string;
  phone: string;
  email: string;
  notes: string;
  tags: string;
  birthday: string | null;
  preferred_staff_id: string | null;
  marketing_opt_in: number;
  merged_into: string | null;
  version: number;
  created_at: number;
  updated_at: number;
};
export const customerSchema = z
  .object({
    name,
    phone: phoneSchema,
    email: z.union([z.literal(""), z.string().trim().email().max(254)]).default(""),
    notes: z.string().trim().max(1000).default(""),
    tags: z.array(z.string().trim().min(1).max(24)).max(12).default([]),
    birthday: z
      .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
      .default(""),
    preferred_staff_id: z.union([z.literal(""), z.string().uuid()]).default(""),
    marketing_opt_in: active.default(0),
    version: version.optional(),
  })
  .strict();
export const colourSchema = z.enum(["sage", "sand", "blue", "clay", "plum", "slate"]);
// Images may be an https URL or a same-origin upload (/media/<id>) or bundled asset (/static/...).
export const imageRef = z.union([z.literal(""), z.string().trim().max(500).refine((u) => /^https:\/\/\S+$/.test(u) || /^\/(media|static)\/[A-Za-z0-9._\/-]+$/.test(u), "Use an https:// image address or an uploaded photo")]);
export const staffSchema = z
  .object({
    name,
    role: z.string().trim().min(2).max(50),
    active: active.default(1),
    version: version.optional(),
    title: z.string().trim().max(60).default(""),
    bio: z.string().trim().max(600).default(""),
    colour: colourSchema.default("sage"),
    photo_url: imageRef.default(""),
    online_visible: active.default(1),
    skills: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
    instagram: z.string().trim().max(40).regex(/^@?[A-Za-z0-9._]*$/, "Instagram handle only").default(""),
    start_date: z.union([z.literal(""), dateSchema]).default(""),
    sort_order: z.number().int().min(0).max(999).default(0),
    commission_pct: z.number().int().min(0).max(100).default(50),
    pay_model: z.enum(["COMMISSION", "CHAIR_RENT", "HOURLY", "SALARY", "HYBRID"]).default("COMMISSION"),
    pay_period: z.enum(["WEEKLY", "FORTNIGHTLY", "MONTHLY"]).default("WEEKLY"),
    base_pence: z.number().int().min(0).max(10000000).default(0),
    hourly_pence: z.number().int().min(0).max(100000).default(0),
    rent_pence: z.number().int().min(0).max(10000000).default(0),
    commission_threshold_pence: z.number().int().min(0).max(10000000).default(0),
    commission_tiers: z
      .array(z.object({ from_pence: z.number().int().min(0).max(10000000), pct: z.number().int().min(0).max(100) }))
      .max(6)
      .default([])
      .refine((t) => t.every((x, i) => i === 0 || x.from_pence > t[i - 1].from_pence), "Tiers must increase"),
    tip_share_pct: z.number().int().min(0).max(100).default(100),
    product_commission_pct: z.number().int().min(0).max(100).default(0),
    employment: z.enum(["SELF_EMPLOYED", "EMPLOYED"]).default("SELF_EMPLOYED"),
    pay_notes: z.string().trim().max(600).default(""),
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
    description: z.string().trim().max(400).default(""),
    colour: colourSchema.default("sage"),
    online_bookable: active.default(1),
    popular: active.default(0),
    sort_order: z.number().int().min(0).max(999).default(0),
  })
  .strict();
// Batch of per-barber rules for one service (or one barber): the service studio matrix.
export const ruleMatrixSchema = z
  .object({
    rules: z
      .array(
        z
          .object({
            staff_id: z.string().uuid(),
            service_id: z.string().uuid(),
            enabled: active,
            price_pence: z.number().int().min(0).max(100000).nullable().default(null),
            duration_min: z.number().int().min(5).max(240).nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export const addonSchema = z
  .object({
    name,
    price_pence: z.number().int().min(0).max(100000),
    duration_min: z.number().int().min(0).max(120),
    active: active.default(1),
    service_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((a) => new Set(a).size === a.length, "Duplicate services"),
    version: version.optional(),
  })
  .strict();
export const serviceRuleSchema = z
  .object({
    enabled: active,
    price_pence: z.number().int().min(0).max(100000).nullable(),
    duration_min: z.number().int().min(5).max(240).nullable(),
    version,
  })
  .strict();
const shopDaySchema = z
  .object({ enabled: z.union([z.literal(0), z.literal(1)]), starts: z.number().int().min(0).max(1439), ends: z.number().int().min(1).max(1440) })
  .strict()
  .refine((d) => !d.enabled || d.ends > d.starts, "Closing time must be after opening time");
// Display currencies a shop can pick. Prices are stored in minor units regardless; this only drives formatting.
export const currencies = ["GBP", "EUR", "USD", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "AED", "ZAR", "INR", "SGD", "HKD", "JPY"] as const;
export type Currency = (typeof currencies)[number];
export const shopSchema = z
  .object({
    name,
    address: z.string().trim().max(200),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-GB", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "Unknown timezone"),
    week: z.array(shopDaySchema).length(7).refine((w) => w.some((d) => d.enabled), "Open at least one day"),
    currency: z.enum(currencies).default("GBP"),
    deposit_pence: z.number().int().min(0).max(10000),
    cancel_hours: z.number().int().min(0).max(168),
    no_show_grace: z.number().int().min(0).max(120),
    till_access: z.enum(["OWNER", "ALL"]).default("OWNER"),
    version,
  })
  .strict();
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Use at least 3 characters")
  .max(40)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Use lowercase letters, numbers and single hyphens",
  )
  .refine(
    (s) => !["api", "static", "workspace", "preview", "manage", "book", "offer", "media", "docs", "signin", "signup", "forgot", "reset", "admin", "demo-shop", "robots.txt", "sitemap.xml"].includes(s),
    "This address is reserved",
  );
export type ShopPage = {
  shop_id: string;
  strapline: string;
  about: string;
  cover_url: string;
  logo_url: string;
  gallery_json: string;
  phone: string;
  email: string;
  instagram: string;
  map_url: string;
  transport_note: string;
  policy_text: string;
  sections_json: string;
  accent: "ollo" | "ink" | "sage" | "clay" | "plum" | "slate";
  theme_json: string;
  published: number;
  version: number;
  updated_at: number;
};
// Shop page theme. Each option is a curated, named choice so every combination looks designed.
export const themeFonts = ["modern", "editorial", "grotesk", "heritage", "condensed", "soft"] as const;
export const themeModes = ["light", "dark"] as const;
export const themeCorners = ["soft", "sharp"] as const;
export const themeHeroes = ["editorial", "centred", "split"] as const;
export const themeLogos = ["auto", "original"] as const; // auto: dark single-colour logos flip to white on dark surfaces
export const stockCovers = ["brick", "minimal", "tools", "heritage", "industrial", "terracotta"] as const;
export const themeSchema = z
  .object({
    font: z.enum(themeFonts).default("modern"),
    mode: z.enum(themeModes).default("light"),
    corners: z.enum(themeCorners).default("soft"),
    hero: z.enum(themeHeroes).default("editorial"),
    logo: z.enum(themeLogos).default("auto"),
  })
  .strict();
export type ShopTheme = z.infer<typeof themeSchema>;
export const defaultTheme: ShopTheme = { font: "modern", mode: "light", corners: "soft", hero: "editorial", logo: "auto" };
export function parseTheme(json: string | null | undefined): ShopTheme {
  try {
    const r = themeSchema.safeParse(JSON.parse(json || "{}"));
    return r.success ? r.data : defaultTheme;
  } catch {
    return defaultTheme;
  }
}
export const pageSections = ["hero", "next", "services", "team", "hours", "gallery", "reviews", "find", "policies"] as const;
const httpsUrl = z.union([z.literal(""), z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "Use an https:// address")]);
export const shopPageSchema = z
  .object({
    strapline: z.string().trim().max(120).default(""),
    about: z.string().trim().max(1200).default(""),
    cover_url: imageRef.default(""),
    logo_url: imageRef.default(""),
    gallery: z.array(imageRef.refine((u) => u !== "", "Empty gallery entry")).max(12).default([]),
    phone: z.union([z.literal(""), z.string().trim().max(20).regex(/^[+0-9 ()-]+$/, "Phone number only")]).default(""),
    email: z.union([z.literal(""), z.string().trim().email().max(254)]).default(""),
    instagram: z.string().trim().max(40).regex(/^@?[A-Za-z0-9._]*$/, "Instagram handle only").default(""),
    map_url: httpsUrl.default(""),
    transport_note: z.string().trim().max(300).default(""),
    policy_text: z.string().trim().max(1200).default(""),
    sections: z.array(z.enum(pageSections)).max(pageSections.length).default([...pageSections]),
    accent: z.enum(["ollo", "ink", "sage", "clay", "plum", "slate"]).default("ollo"),
    theme: themeSchema.default(defaultTheme),
    published: active.default(1),
    version,
  })
  .strict();
export const defaultShopPage = (shopId: string, now = Date.now()): ShopPage => ({
  shop_id: shopId,
  strapline: "",
  about: "",
  cover_url: "",
  logo_url: "",
  gallery_json: "[]",
  phone: "",
  email: "",
  instagram: "",
  map_url: "",
  transport_note: "",
  policy_text: "",
  sections_json: JSON.stringify(pageSections),
  accent: "ollo",
  theme_json: "{}",
  published: 1,
  version: 0,
  updated_at: now,
});
export const onlineBookingSchema = z
  .object({
    slug: slugSchema,
    online_booking: active,
    lead_time_min: z.number().int().min(0).max(10080),
    booking_window_days: z.number().int().min(1).max(365),
    version,
  })
  .strict();
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((s) => s === "" || z.string().email().safeParse(s).success, "Enter a valid email address");
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
export const overrideSchema = z
  .object({
    date: dateSchema,
    enabled: active,
    starts: z.number().int().min(0).max(1439),
    ends: z.number().int().min(1).max(1440),
    break_start: z.number().int().min(0).max(1440),
    break_end: z.number().int().min(0).max(1440),
    reason: z.string().trim().min(3).max(100),
    version: version.optional(),
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
export const addonIdsSchema = z
  .array(z.string().uuid())
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, "Choose each add-on once")
  .transform((ids) => [...ids].sort());
export const holidaySchema = z
  .object({ date: dateSchema, label: z.string().trim().min(2).max(100) })
  .strict();
export const dayOffSchema = z
  .object({ date: dateSchema, reason: z.string().trim().min(3).max(100) })
  .strict();
// UK mobile, normalised. Walk-ins may leave it empty (checked at the object level).
export const ukMobileOrEmpty = z
  .string()
  .transform((s) => s.replace(/[\s()-]/g, ""))
  .refine((s) => s === "" || /^(?:\+44|0)7\d{9}$/.test(s), "Enter a valid UK mobile number");
export const ukMobile = ukMobileOrEmpty.refine((s) => s !== "", "Enter a valid UK mobile number");
const bookingBase = z
  .object({
    request_id: z.string().uuid(),
    staff_id: z.string().uuid(),
    service_id: z.string().uuid(),
    customer_name: name,
    phone: ukMobileOrEmpty,
    notes: z.string().trim().max(500).default(""),
    date: dateSchema,
    start_min: z
      .number()
      .int()
      .min(0)
      .max(1425)
      .refine((v) => v % 15 === 0, "Choose a 15-minute start"),
    source: z.enum(["TEST_BOOKING", "WALK_IN"]),
    addon_ids: addonIdsSchema.default([]),
    customer_id: z.string().regex(/^[0-9a-f-]{32,36}$/).optional(),
    quote: z
      .object({ service_version: version, shop_version: version })
      .strict(),
  })
  .strict();
// Owner booking: walk-ins may omit the phone; everything else needs one.
export const bookingSchema = bookingBase.refine((b) => b.phone !== "" || b.source === "WALK_IN", {
  path: ["phone"],
  message: "Enter a valid UK mobile number",
});
export const publicBookingSchema = z
  .object({
    request_id: z.string().uuid(),
    staff_id: z.string().uuid(),
    service_id: z.string().uuid(),
    customer_name: name,
    // Booking for someone else: who sits in the chair. Contact stays the booker's.
    attendee_name: z.union([z.literal(""), name]).default(""),
    phone: z
      .string()
      .transform((s) => s.replace(/[\s()-]/g, ""))
      .refine(
        (s) => /^(?:\+44|0)7\d{9}$/.test(s),
        "Enter a valid UK mobile number",
      ),
    email: emailSchema.default(""),
    notes: z.string().trim().max(500).default(""),
    date: dateSchema,
    start_min: z
      .number()
      .int()
      .min(0)
      .max(1425)
      .refine((v) => v % 15 === 0, "Choose a 15-minute start"),
    addon_ids: addonIdsSchema.default([]),
    quote: z
      .object({ service_version: version, shop_version: version })
      .strict(),
  })
  .strict();
// Group booking: 2-4 visits saved together for one booker on one day. Each member picks a
// service, optional barber and start; "together" (same start, different barbers) or
// "back to back" (same barber, consecutive) are just particular shapes of this list.
export const groupBookingSchema = z
  .object({
    request_id: z.string().uuid(),
    customer_name: name,
    phone: publicBookingSchema.shape.phone,
    email: publicBookingSchema.shape.email,
    notes: z.string().trim().max(500).default(""),
    date: dateSchema,
    members: z
      .array(
        z
          .object({
            attendee_name: z.union([z.literal(""), name]).default(""),
            staff_id: z.string().uuid(),
            service_id: z.string().uuid(),
            addon_ids: addonIdsSchema.default([]),
            start_min: z.number().int().min(0).max(1425).refine((v) => v % 15 === 0),
            quote: z.object({ service_version: version, shop_version: version }).strict(),
          })
          .strict(),
      )
      .min(2)
      .max(4),
  })
  .strict();
export const seriesSchema = bookingBase
  .omit({ request_id: true })
  .extend({
    phone: ukMobile,
    interval_weeks: z.number().int().min(1).max(12),
    occurrences: z.number().int().min(2).max(26),
    skip_dates: z.array(dateSchema).max(26).default([]),
  })
  .strict();
export const bookingDetailsSchema = z
  .object({
    customer_name: name,
    phone: ukMobile,
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
export type Payment = {
  id: string;
  shop_id: string;
  booking_id: string;
  staff_id: string;
  customer_id: string | null;
  date: string;
  method: "CARD" | "CASH" | "TRANSFER" | "VOUCHER";
  service_pence: number;
  tip_pence: number;
  discount_pence: number;
  commission_pct: number;
  note: string;
  recorded_by: string;
  voided_at: number | null;
  void_reason: string;
  created_at: number;
};
export const paymentMethods = ["CARD", "CASH", "TRANSFER", "VOUCHER"] as const;
// Checkout: one or more tenders against a visit. Service amount defaults to the booking price
// less discount; tips are recorded separately and belong to the barber.
export const checkoutSchema = z
  .object({
    version,
    discount_pence: z.number().int().min(0).max(100000).default(0),
    note: z.string().trim().max(300).default(""),
    tenders: z
      .array(
        z.object({
          method: z.enum(paymentMethods),
          service_pence: z.number().int().min(0).max(1000000),
          tip_pence: z.number().int().min(0).max(100000).default(0),
        }),
      )
      .min(1)
      .max(4),
    complete: z.boolean().default(true),
  })
  .strict();
export const payRunCreateSchema = z
  .object({
    staff_id: z.string().uuid(),
    period_from: dateSchema,
    period_to: dateSchema,
    adjustments: z.array(z.object({ label: z.string().trim().min(1).max(60), pence: z.number().int().min(-10000000).max(10000000) })).max(10).default([]),
    note: z.string().trim().max(300).default(""),
  })
  .strict()
  .refine((p) => p.period_to >= p.period_from, "Period end must be on or after start");
export const payRunUpdateSchema = z
  .object({
    version,
    status: z.enum(["DRAFT", "APPROVED", "PAID", "VOID"]).optional(),
    paid_method: z.enum(["BANK", "CASH", "OTHER"]).optional(),
    paid_reference: z.string().trim().max(80).default(""),
    adjustments: z.array(z.object({ label: z.string().trim().min(1).max(60), pence: z.number().int().min(-10000000).max(10000000) })).max(10).optional(),
    note: z.string().trim().max(300).optional(),
    reason: z.string().trim().max(300).default(""),
  })
  .strict();
export function payTermsOf(s: Staff): PayTerms {
  let tiers: { from_pence: number; pct: number }[] = [];
  try {
    tiers = JSON.parse(s.commission_tiers || "[]");
  } catch {
    tiers = [];
  }
  return {
    pay_model: s.pay_model,
    pay_period: s.pay_period,
    commission_pct: s.commission_pct,
    base_pence: s.base_pence,
    hourly_pence: s.hourly_pence,
    rent_pence: s.rent_pence,
    commission_threshold_pence: s.commission_threshold_pence,
    commission_tiers: tiers,
    tip_share_pct: s.tip_share_pct,
    product_commission_pct: s.product_commission_pct,
    employment: s.employment,
    pay_notes: s.pay_notes,
  };
}
// Commission on service takings. Tiers are marginal bands on the period's takings
// (e.g. 40% to £1,000, 50% above). Flat % when no tiers are set.
export function commissionFor(terms: PayTerms, servicePence: number) {
  const eligible = Math.max(0, servicePence - (terms.pay_model === "HYBRID" ? terms.commission_threshold_pence : 0));
  if (!terms.commission_tiers.length) return Math.round((eligible * terms.commission_pct) / 100);
  let total = 0;
  const tiers = [...terms.commission_tiers].sort((a, b) => a.from_pence - b.from_pence);
  for (let i = 0; i < tiers.length; i++) {
    const from = tiers[i].from_pence;
    const to = tiers[i + 1]?.from_pence ?? Number.POSITIVE_INFINITY;
    if (eligible <= from) break;
    total += Math.round(((Math.min(eligible, to) - from) * tiers[i].pct) / 100);
  }
  return total;
}
// One pay-run calculation; pure so it can be unit-tested and previewed before saving.
export function calculatePayRun(
  terms: PayTerms,
  input: { service_pence: number; tips_pence: number; visits: number; hours_x100: number; periods: number },
  adjustments: { label: string; pence: number }[] = [],
) {
  const periods = Math.max(1, input.periods);
  const tip_pence = Math.round((input.tips_pence * terms.tip_share_pct) / 100);
  let commission_pence = 0, base_pence = 0, hourly_pence = 0, rent_pence = 0;
  switch (terms.pay_model) {
    case "COMMISSION":
      commission_pence = commissionFor(terms, input.service_pence);
      break;
    case "CHAIR_RENT":
      rent_pence = terms.rent_pence * periods;
      break;
    case "HOURLY":
      hourly_pence = Math.round((input.hours_x100 * terms.hourly_pence) / 100);
      break;
    case "SALARY":
      base_pence = terms.base_pence * periods;
      break;
    case "HYBRID":
      base_pence = terms.base_pence * periods;
      commission_pence = commissionFor(terms, input.service_pence);
      break;
  }
  const adjustments_pence = adjustments.reduce((n, a) => n + a.pence, 0);
  // Chair rent: the barber keeps their own takings (already in their pocket); the shop is owed rent
  // less any tips the shop collected on their behalf.
  const net_pence =
    terms.pay_model === "CHAIR_RENT"
      ? tip_pence - rent_pence + adjustments_pence
      : commission_pence + base_pence + hourly_pence + tip_pence + adjustments_pence;
  return { commission_pence, base_pence, hourly_pence, tip_pence, rent_pence, adjustments_pence, net_pence };
}
export const voidPaymentSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
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

// A dated override replaces that day's weekly shift/break; shop closures and full-day leave still win.
export function effectiveHours(
  weekly: Hours | null,
  override: ScheduleOverride | null,
): Hours | null {
  return override ? { ...override, weekday: weekday(override.date) } : weekly;
}
export function calculateQuote(
  service: Service,
  rule: StaffServiceRule | null,
  addons: Addon[],
  links: AddonLink[],
  ids: string[],
) {
  if (!service.active) throw new Error("service_unavailable");
  if (rule?.enabled === 0) throw new Error("service_ineligible");
  if (new Set(ids).size !== ids.length || ids.length > 10)
    throw new Error("addon_unavailable");
  const items: BookingItem[] = [
    {
      kind: "SERVICE",
      id: service.id,
      name: service.name,
      price_pence: rule?.price_pence ?? service.price_pence,
      duration_min: rule?.duration_min ?? service.duration_min,
    },
  ];
  for (const id of [...ids].sort()) {
    const a = addons.find(
      (a) => a.id === id && a.shop_id === service.shop_id && a.active,
    );
    if (
      !a ||
      !links.some(
        (l) =>
          l.shop_id === service.shop_id &&
          l.addon_id === id &&
          l.service_id === service.id,
      )
    )
      throw new Error("addon_unavailable");
    items.push({
      kind: "ADDON",
      id: a.id,
      name: a.name,
      price_pence: a.price_pence,
      duration_min: a.duration_min,
    });
  }
  return {
    items,
    price_pence: items.reduce((n, i) => n + i.price_pence, 0),
    duration_min: items.reduce((n, i) => n + i.duration_min, 0),
  };
}

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
  daysOff: StaffDayOff[] = [],
): string {
  if (!staff?.active) return "Barber unavailable";
  if (
    daysOff.some(
      (d) =>
        d.staff_id === staff.id && d.date === date && d.shop_id === shop.id,
    )
  )
    return "Barber has a day off";
  const day = shopDay(shop, weekday(date));
  if (!day.enabled || holidays.some((h) => h.date === date)) return "Shop closed";
  if (!hours?.enabled) return "Barber off duty";
  if (
    start < Math.max(day.starts, hours.starts) ||
    start + duration + 10 > Math.min(day.ends, hours.ends)
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
