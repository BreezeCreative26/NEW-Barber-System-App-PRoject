// Customer accounts: passwordless sign-in by one-time code, scoped to one shop per session.
// Mounted under /api/public/shops/:slug/account. In the sandbox the code is never sent: it is
// returned to the page (shown on screen) and written to the shop's audit log.
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { brandOf, dayStarts, phoneSchema, ref, shopToday, type Customer, type Shop, type StoredBooking } from "./domain";
import { digest, readInput, type AppEnv } from "./accounts";
import { audit, checkVersionUpdate, fail, readBooking } from "./sandbox";
import { leaveReview, ownReviewView, reviewEligibility, reviewSchema, type ReviewRow } from "./presence";
import {
  calendarResponse,
  cancelBody,
  cancelByCustomer,
  clientKey,
  customerView,
  datePlus,
  limits,
  moveBody,
  moveByCustomer,
  moveOptions,
  rangeContext,
  shopBySlug,
  slotFor,
  throttle,
  type Ctx,
} from "./public";

export const CUSTOMER_COOKIE = "ollo_customer";
const uid = () => crypto.randomUUID();
const CODE_TTL = 10 * 60000;
const SESSION_TTL = 90 * 86400000;

type AccountRow = { id: string; phone: string; email: string; name: string; created_at: number; last_seen_at: number; version: number };

const startSchema = z.object({ phone: phoneSchema }).strict();
const verifySchema = z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }).strict();
const profileSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(254)]).default(""),
    birthday: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).default(""),
    preferred_staff_id: z.union([z.literal(""), z.string().uuid()]).default(""),
    marketing_opt_in: z.union([z.literal(0), z.literal(1)]).default(0),
    notes: z.string().trim().max(500).default(""),
    version: z.number().int().min(0),
  })
  .strict();

function cookie(c: Ctx, raw: string) {
  setCookie(c, CUSTOMER_COOKIE, raw, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL / 1000 });
}

// Signed-in customer for this shop, or null. Sessions are shop-scoped so a token from shop A
// never reads shop B.
async function currentAccount(c: Ctx, shop: Shop) {
  const raw = getCookie(c, CUSTOMER_COOKIE);
  if (!raw || raw.length < 60) return null;
  const row = await c.env.DB.prepare(
    "SELECT a.* FROM customer_sessions s JOIN customer_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.shop_id=? AND s.expires_at>?",
  )
    .bind(await digest(raw), shop.id, Date.now())
    .first<AccountRow>();
  return row;
}
async function requireAccount(c: Ctx, shop: Shop) {
  const a = await currentAccount(c, shop);
  if (!a) return fail(401, "Sign in to see your visits");
  c.set("actor", `customer:${a.id}`);
  return a;
}
// The shop's customer row this account maps to. Created on first sign-in if the shop has never
// seen this phone; follows merges so history stays in one place.
async function linkedCustomer(c: Ctx, shop: Shop, account: AccountRow): Promise<Customer> {
  const now = Date.now();
  let cust = await c.env.DB.prepare(
    "SELECT c.* FROM customer_account_links l JOIN customers c ON c.shop_id=l.shop_id AND c.id=l.customer_id WHERE l.account_id=? AND l.shop_id=?",
  )
    .bind(account.id, shop.id)
    .first<Customer>();
  if (cust?.merged_into) {
    cust = await c.env.DB.prepare("SELECT * FROM customers WHERE shop_id=? AND id=?").bind(shop.id, cust.merged_into).first<Customer>();
    if (cust) await c.env.DB.prepare("UPDATE customer_account_links SET customer_id=? WHERE account_id=? AND shop_id=?").bind(cust.id, account.id, shop.id).run();
  }
  if (cust) return cust;
  cust = await c.env.DB.prepare("SELECT * FROM customers WHERE shop_id=? AND phone=?").bind(shop.id, account.phone).first<Customer>();
  if (cust?.merged_into) cust = await c.env.DB.prepare("SELECT * FROM customers WHERE shop_id=? AND id=?").bind(shop.id, cust.merged_into).first<Customer>();
  if (!cust) {
    const id = uid();
    await c.env.DB.prepare(
      "INSERT INTO customers(id,shop_id,name,phone,email,notes,tags,birthday,preferred_staff_id,marketing_opt_in,created_at,updated_at) VALUES(?,?,?,?,?,'','[]',NULL,NULL,0,?,?)",
    )
      .bind(id, shop.id, account.name || "Customer", account.phone, account.email, now, now)
      .run();
    cust = (await c.env.DB.prepare("SELECT * FROM customers WHERE shop_id=? AND id=?").bind(shop.id, id).first<Customer>())!;
  }
  await c.env.DB.prepare("INSERT INTO customer_account_links(account_id,shop_id,customer_id,linked_at) VALUES(?,?,?,?) ON CONFLICT (account_id,shop_id) DO UPDATE SET customer_id=EXCLUDED.customer_id, linked_at=EXCLUDED.linked_at")
    .bind(account.id, shop.id, cust.id, now)
    .run();
  return cust;
}
async function ownBooking(c: Ctx, shop: Shop, customer: Customer, id: string) {
  const booking = await readBooking(c, id);
  if (booking.customer_id !== customer.id && booking.phone !== customer.phone) fail(404, "Booking not found");
  const staff = await c.env.DB.prepare("SELECT name FROM staff WHERE shop_id=? AND id=?").bind(shop.id, booking.staff_id).first<{ name: string }>();
  return { booking, staffName: staff?.name ?? null };
}
const profileOf = (a: AccountRow, cust: Customer) => ({
  id: a.id,
  phone: a.phone,
  name: cust.name || a.name,
  email: cust.email || a.email,
  birthday: cust.birthday || "",
  preferred_staff_id: cust.preferred_staff_id || "",
  marketing_opt_in: cust.marketing_opt_in,
  notes: cust.notes,
  version: cust.version,
  member_since: a.created_at,
});

const acct = new Hono<AppEnv>();

// Step 1: request a code. Sandbox: returned in the response; production would send it.
acct.post("/start", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const b = await readInput(c, startSchema);
  await throttle(c, "otp-start", `${shop.id}:${clientKey(c)}`, 30);
  await throttle(c, "otp-phone", `${shop.id}:${b.phone}`, 8);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO customer_otp(shop_id,phone,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,0,?) ON CONFLICT(shop_id,phone) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at",
    ).bind(shop.id, b.phone, await digest(`${shop.id}:${b.phone}:${code}`), now + CODE_TTL, now),
    audit(c, "customer_account", b.phone.slice(-4), "SIGN_IN_CODE_ISSUED", `Local test: one-time code shown on screen for a mobile ending ${b.phone.slice(-4)}. No message sent.`),
  ]);
  return c.json({ ok: true, phone: b.phone, expires_at: now + CODE_TTL, sandbox_code: code, delivery: "on_screen" }, 201);
});

// Step 2: verify. Creates the global account on first use and links it to this shop's customer row.
acct.post("/verify", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const b = await readInput(c, verifySchema);
  await throttle(c, "otp-verify", `${shop.id}:${clientKey(c)}`, 60);
  const now = Date.now();
  const otp = await c.env.DB.prepare("SELECT * FROM customer_otp WHERE shop_id=? AND phone=?").bind(shop.id, b.phone).first<{ code_hash: string; expires_at: number; attempts: number }>();
  if (!otp || otp.expires_at <= now) return fail(409, "That code has expired. Request a new one.");
  if (otp.attempts >= 5) fail(429, "Too many wrong codes. Request a new one.");
  if (otp.code_hash !== (await digest(`${shop.id}:${b.phone}:${b.code}`))) {
    await c.env.DB.prepare("UPDATE customer_otp SET attempts=attempts+1 WHERE shop_id=? AND phone=?").bind(shop.id, b.phone).run();
    fail(401, "That code is not right. Check it and try again.");
  }
  let account = await c.env.DB.prepare("SELECT * FROM customer_accounts WHERE phone=?").bind(b.phone).first<AccountRow>();
  if (!account) {
    // Seed the account name/email from what this shop already knows about the phone.
    const known = await c.env.DB.prepare("SELECT name,email FROM customers WHERE shop_id=? AND phone=? AND merged_into IS NULL").bind(shop.id, b.phone).first<{ name: string; email: string }>();
    await c.env.DB.prepare("INSERT INTO customer_accounts(id,phone,email,name,created_at,last_seen_at,version) VALUES(?,?,?,?,?,?,0)")
      .bind(uid(), b.phone, known?.email ?? "", known?.name ?? "", now, now)
      .run();
    account = (await c.env.DB.prepare("SELECT * FROM customer_accounts WHERE phone=?").bind(b.phone).first<AccountRow>())!;
  }
  const raw = uid() + uid();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM customer_otp WHERE shop_id=? AND phone=?").bind(shop.id, b.phone),
    c.env.DB.prepare("UPDATE customer_accounts SET last_seen_at=? WHERE id=?").bind(now, account.id),
    c.env.DB.prepare("INSERT INTO customer_sessions(token_hash,account_id,shop_id,created_at,expires_at) VALUES(?,?,?,?,?)").bind(await digest(raw), account.id, shop.id, now, now + SESSION_TTL),
    audit(c, "customer_account", account.id, "CUSTOMER_SIGNED_IN", `Customer signed in online (mobile ending ${b.phone.slice(-4)}).`),
  ]);
  c.set("actor", `customer:${account.id}`);
  const cust = await linkedCustomer(c, shop, account);
  cookie(c, raw);
  return c.json({ ok: true, profile: profileOf(account, cust), new_account: account.created_at === now }, 201);
});

acct.post("/logout", async (c) => {
  await shopBySlug(c, c.req.param("slug")!);
  await readInput(c, z.object({}).strict());
  const raw = getCookie(c, CUSTOMER_COOKIE);
  if (raw) await c.env.DB.prepare("DELETE FROM customer_sessions WHERE token_hash=?").bind(await digest(raw)).run();
  deleteCookie(c, CUSTOMER_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

// Who am I on this shop (null when signed out). Used by the shop page and booking flow to prefill.
acct.get("/session", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await currentAccount(c, shop);
  if (!a) return c.json({ profile: null });
  const cust = await linkedCustomer(c, shop, a);
  return c.json({ profile: profileOf(a, cust) });
});

// The customer area: upcoming, history, "your usual", profile — only this shop's rows.
acct.get("/me", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  const cust = await linkedCustomer(c, shop, a);
  const now = Date.now();
  const rows = await c.env.DB.prepare(
    "SELECT b.*, s.name AS staff_name FROM bookings b LEFT JOIN staff s ON s.shop_id=b.shop_id AND s.id=b.staff_id WHERE b.shop_id=? AND (b.customer_id=? OR b.phone=?) ORDER BY b.start_at DESC LIMIT 200",
  )
    .bind(shop.id, cust.id, cust.phone)
    .all<StoredBooking & { staff_name: string | null }>();
  const all = rows.results;
  // Reviews this customer has left here, keyed by booking, so history rows can show/offer them.
  const reviewRows = all.length
    ? await c.env.DB.prepare(`SELECT * FROM reviews WHERE shop_id=? AND booking_id IN (${all.map(() => "?").join(",")})`).bind(shop.id, ...all.map((b) => b.id)).all<ReviewRow>()
    : { results: [] as ReviewRow[] };
  const reviewBy = new Map(reviewRows.results.map((r) => [r.booking_id, r]));
  const view = (b: StoredBooking & { staff_name: string | null }) => {
    const r = reviewBy.get(b.id) ?? null;
    const can = reviewEligibility(b, r, now);
    return { ...customerView(b, shop, b.staff_name), service_id: b.service_id, series_id: b.series_id, review: ownReviewView(r), can_review: can.ok };
  };
  const upcoming = all.filter((b) => b.start_at > now && ["CONFIRMED", "CHECKED_IN", "IN_SERVICE"].includes(b.status)).sort((x, y) => x.start_at - y.start_at).map(view);
  const history = all.filter((b) => !(b.start_at > now && ["CONFIRMED", "CHECKED_IN", "IN_SERVICE"].includes(b.status))).map(view);
  const completed = all.filter((b) => b.status === "COMPLETED").sort((x, y) => y.start_at - x.start_at);
  // "Your usual": most-booked service + barber pair among completed visits, with the typical gap.
  let usual: null | { service_id: string; service_name: string; staff_id: string; staff_name: string | null; gap_weeks: number | null; price_pence: number; count: number } = null;
  if (completed.length) {
    const tally = new Map<string, { n: number; b: (typeof completed)[number] }>();
    for (const b of completed) {
      const k = `${b.service_id}|${b.staff_id}`;
      const t = tally.get(k);
      if (t) t.n++;
      else tally.set(k, { n: 1, b });
    }
    const best = [...tally.values()].sort((x, y) => y.n - x.n || y.b.start_at - x.b.start_at)[0];
    const gaps: number[] = [];
    for (let i = 0; i + 1 < completed.length && i < 6; i++) gaps.push((completed[i].start_at - completed[i + 1].start_at) / (7 * 86400000));
    const gap = gaps.length ? Math.max(1, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)) : null;
    usual = { service_id: best.b.service_id, service_name: best.b.service_name, staff_id: best.b.staff_id, staff_name: best.b.staff_name, gap_weeks: gap, price_pence: best.b.price_pence, count: best.n };
  }
  // Next free slot for the usual, if the service and barber are still bookable online.
  let next_usual: null | { date: string; start_min: number; price_pence: number } = null;
  if (usual) {
    try {
      const { today, minStart } = limits(shop);
      const horizon = datePlus(today, Math.min(shop.booking_window_days, 21));
      const ctx = await rangeContext(c, shop, [usual.staff_id], usual.service_id, today, horizon, []);
      const st = ctx.staff[0];
      outer: for (let d = 0; d <= 21; d++) {
        const date = datePlus(today, d);
        if (date > horizon) break;
        for (const m of dayStarts(shop, date)) {
          if (!slotFor(shop, ctx, st, date, m, minStart)) {
            next_usual = { date, start_min: m, price_pence: ctx.quotes.get(st.id)!.price_pence };
            break outer;
          }
        }
      }
    } catch {
      next_usual = null;
    }
  }
  const staff = await c.env.DB.prepare("SELECT id,name FROM staff WHERE shop_id=? AND active=1 AND online_visible=1 ORDER BY sort_order,name").bind(shop.id).all<{ id: string; name: string }>();
  // Waiting-list requests (open or with an offer pending) for this customer at this shop.
  const waiting = await c.env.DB.prepare(
    "SELECT w.id,w.date,w.daypart,w.status,w.version,s.name AS service_name,st.name AS staff_name,o.start_min AS offer_start_min,o.expires_at AS offer_expires_at,os.name AS offer_staff_name FROM waitlist_entries w JOIN services s ON s.shop_id=w.shop_id AND s.id=w.service_id LEFT JOIN staff st ON st.shop_id=w.shop_id AND st.id=w.staff_id LEFT JOIN waitlist_offers o ON o.id=w.offer_id LEFT JOIN staff os ON os.shop_id=o.shop_id AND os.id=o.staff_id WHERE w.shop_id=? AND w.phone=? AND w.status IN ('OPEN','OFFERED') AND w.date>=? ORDER BY w.date",
  )
    .bind(shop.id, cust.phone, shopToday(shop.timezone, now))
    .all();
  return c.json({
    waiting: waiting.results,
    shop: { name: shop.name, slug: shop.slug, address: shop.address, timezone: shop.timezone, currency: shop.currency || "GBP", cancel_hours: shop.cancel_hours, lead_time_min: shop.lead_time_min, today: shopToday(shop.timezone, now), logo_url: shop.logo_url || "", brand: brandOf(shop) },
    profile: profileOf(a, cust),
    upcoming,
    history,
    usual,
    next_usual,
    staff: staff.results,
    stats: { visits: completed.length, spent_pence: completed.reduce((s, b) => s + b.price_pence, 0), first_visit: completed.at(-1)?.date ?? null },
    now,
  });
});

acct.put("/profile", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  const cust = await linkedCustomer(c, shop, a);
  const b = await readInput(c, profileSchema);
  if (b.preferred_staff_id) {
    const ok = await c.env.DB.prepare("SELECT 1 FROM staff WHERE shop_id=? AND id=? AND active=1").bind(shop.id, b.preferred_staff_id).first();
    if (!ok) fail(404, "Barber not found");
  }
  const now = Date.now();
  await checkVersionUpdate(
    c,
    c.env.DB.prepare(
      "UPDATE customers SET name=?,email=?,birthday=?,preferred_staff_id=?,marketing_opt_in=?,notes=?,version=version+1,updated_at=? WHERE shop_id=? AND id=? AND version=?",
    ).bind(b.name, b.email, b.birthday || null, b.preferred_staff_id || null, b.marketing_opt_in, b.notes, now, shop.id, cust.id, b.version),
    audit(c, "customer", cust.id, "CUSTOMER_PROFILE_SELF_UPDATED", "Customer updated their own profile online.", true),
  );
  await c.env.DB.prepare("UPDATE customer_accounts SET name=?,email=?,version=version+1 WHERE id=?").bind(b.name, b.email, a.id).run();
  const fresh = (await c.env.DB.prepare("SELECT * FROM customers WHERE shop_id=? AND id=?").bind(shop.id, cust.id).first<Customer>())!;
  return c.json({ profile: profileOf({ ...a, name: b.name, email: b.email }, fresh) });
});

// Manage a visit while signed in: same rules as the manage link.
acct.get("/bookings/:id/availability", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  const cust = await linkedCustomer(c, shop, a);
  const p = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(c.req.query());
  if (!p.success) fail(400, "Supply a valid date");
  const { booking } = await ownBooking(c, shop, cust, c.req.param("id")!);
  return c.json(await moveOptions(c, shop, booking, p.data!.date));
});
acct.post("/bookings/:id/cancel", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  const cust = await linkedCustomer(c, shop, a);
  const body = await readInput(c, cancelBody);
  const { booking, staffName } = await ownBooking(c, shop, cust, c.req.param("id")!);
  return c.json(await cancelByCustomer(c, shop, booking, staffName, body));
});
acct.post("/bookings/:id/reschedule", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  const cust = await linkedCustomer(c, shop, a);
  const body = await readInput(c, moveBody);
  const { booking, staffName } = await ownBooking(c, shop, cust, c.req.param("id")!);
  return c.json(await moveByCustomer(c, shop, booking, staffName, body));
});
// Review a completed visit while signed in (same rule as the manage link: once, within 60 days).
acct.post("/bookings/:id/review", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  const cust = await linkedCustomer(c, shop, a);
  const body = await readInput(c, reviewSchema);
  const { booking } = await ownBooking(c, shop, cust, c.req.param("id")!);
  const r = await leaveReview(c, shop, booking, body, `customer:${a.id}`);
  if (r.error) fail(409, r.error);
  return c.json({ review: ownReviewView(r.review) }, 201);
});
acct.get("/bookings/:id/calendar.ics", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  const cust = await linkedCustomer(c, shop, a);
  const { booking, staffName } = await ownBooking(c, shop, cust, c.req.param("id")!);
  return calendarResponse(c, shop, booking, staffName);
});

// Leave the waiting list for one request.
acct.post("/waitlist/:id/leave", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  const cust = await linkedCustomer(c, shop, a);
  const b = await readInput(c, z.object({ version: z.number().int().min(0) }).strict());
  const entry = await c.env.DB.prepare("SELECT id,version,status FROM waitlist_entries WHERE shop_id=? AND id=? AND phone=?").bind(shop.id, c.req.param("id"), cust.phone).first<{ id: string; version: number; status: string }>();
  if (!entry) return fail(404, "Request not found");
  if (entry.version !== b.version) fail(409, "record_changed");
  if (!["OPEN", "OFFERED"].includes(entry.status)) fail(409, "invalid_transition");
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE waitlist_offers SET status='DECLINED',responded_at=? WHERE shop_id=? AND entry_id=? AND status='PENDING'").bind(now, shop.id, entry.id),
    c.env.DB.prepare("UPDATE waitlist_entries SET status='CLOSED',offer_id=NULL,version=version+1,updated_at=? WHERE id=? AND version=?").bind(now, entry.id, b.version),
    audit(c, "waitlist", entry.id, "WAITLIST_LEFT", "Customer left the waiting list from their account."),
  ]);
  return c.json({ ok: true });
});

// Privacy: export everything this shop holds about me; delete the account (bookings stay with the shop as history).
acct.get("/export", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  const cust = await linkedCustomer(c, shop, a);
  const bookings = await c.env.DB.prepare("SELECT * FROM bookings WHERE shop_id=? AND (customer_id=? OR phone=?) ORDER BY start_at").bind(shop.id, cust.id, cust.phone).all<StoredBooking>();
  c.header("Content-Disposition", `attachment; filename="my-data-${shop.slug}.json"`);
  return c.json({
    exported_at: new Date().toISOString(),
    shop: { name: shop.name, slug: shop.slug },
    account: { phone: a.phone, name: a.name, email: a.email, created_at: a.created_at },
    customer: { name: cust.name, email: cust.email, birthday: cust.birthday, notes: cust.notes, marketing_opt_in: cust.marketing_opt_in, created_at: cust.created_at },
    bookings: bookings.results.map((b) => ({ reference: ref(b), date: b.date, start_min: b.start_min, service: b.service_name, price_pence: b.price_pence, status: b.status, items: JSON.parse(b.items_json) })),
  });
});
acct.post("/delete", async (c) => {
  const shop = await shopBySlug(c, c.req.param("slug")!);
  const a = await requireAccount(c, shop);
  await readInput(c, z.object({ confirm: z.literal("DELETE") }).strict());
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM customer_sessions WHERE account_id=?").bind(a.id),
    c.env.DB.prepare("DELETE FROM customer_account_links WHERE account_id=?").bind(a.id),
    c.env.DB.prepare("DELETE FROM customer_accounts WHERE id=?").bind(a.id),
    audit(c, "customer_account", a.id, "CUSTOMER_ACCOUNT_DELETED", "Customer deleted their online account. Shop visit history is retained."),
  ]);
  deleteCookie(c, CUSTOMER_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

export default acct;
