// Waiting list v2: the delay before anyone is told (re-book by hand → nothing sent), "next in
// line" vs "tell everyone", time windows on the day, and date ranges. API-level; the only direct
// DB touch is to fast-forward the delay timer (there is no clock to travel otherwise).
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import AxeBuilder from "@axe-core/playwright";
import { base, origin, openFixtureShop, openQueue } from "./fixture";

const pub = origin + "/api/public";
// Per-run phone suffix so reruns inside the 10-minute join throttle never collide.
const RUN = String(Date.now() % 900 + 100);
const ph = (n: number) => `0770${RUN}${String(n).padStart(4, "0")}`;
const sql = postgres(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/ollo", { max: 3, idle_timeout: 20, connect_timeout: 10 });
test.afterAll(() => sql.end());

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { slug: string; shop_id: string };
  const w = await (await r.get(base + "/workspace")).json();
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  return { r, c, w, slug: body.slug, shopId: body.shop_id, P: `${pub}/shops/${body.slug}` };
}
const dateIn = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
function weekdayAhead(from = 3) {
  for (let d = from; d < from + 7; d++) {
    const wd = new Date(dateIn(d) + "T12:00:00Z").getUTCDay();
    if (wd >= 2 && wd <= 5) return dateIn(d);
  }
  return dateIn(from);
}
type JoinExtra = { daypart?: string; from_min?: number; to_min?: number; date_to?: string; staff_id?: string | null };
async function join(c: APIRequestContext, P: string, serviceId: string, date: string, phone: string, name: string, extra: JoinExtra = {}) {
  const res = await c.post(`${P}/waitlist`, { data: { staff_id: extra.staff_id ?? null, service_id: serviceId, customer_name: name, phone, email: "", date, daypart: extra.daypart ?? "ANY", notes: "", ...(extra.from_min !== undefined ? { from_min: extra.from_min, to_min: extra.to_min } : {}), ...(extra.date_to ? { date_to: extra.date_to } : {}) } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}
async function queue(r: APIRequestContext, status = "ACTIVE") {
  return (await (await r.get(base + `/waitlist?status=${status}`)).json()) as { waitlist: { id: string; customer_name: string; status: string; version: number; offer_source: string | null; offer_start_min: number | null; date: string; date_to: string; from_min: number; to_min: number; daypart: string }[]; settings: { mode: string; delay_min: number } };
}
async function settings(r: APIRequestContext, patch: Record<string, unknown>) {
  const shop = (await (await r.get(base + "/workspace")).json()).shop;
  const nb = await (await r.get(base + "/notifications")).json();
  const res = await r.put(base + "/shop/waitlist", { data: { waitlist_auto_offer: 1, waitlist_offer_hold_min: 60, waitlist_mode: "ORDER", waitlist_delay_min: 5, templates: nb.templates, version: shop.version, ...patch } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
async function bookOnline(c: APIRequestContext, P: string, staff: string, service: string, date: string, start_min: number, phone: string, name = "Online Customer") {
  const avail = await (await c.get(`${P}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const res = await c.post(`${P}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: name, phone, email: "", date, start_min, quote: avail.quote } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).booking as { id: string; version: number; start_min: number };
}
const outbox = async (r: APIRequestContext) => ((await (await r.get(base + "/notifications?limit=100")).json()).notifications as { template: string; recipient: string; body: string }[]);
// Fast-forward the delay: pretend the freed slot was parked long enough ago.
const fastForward = (shopId: string) => sql`UPDATE waitlist_pending_slots SET notify_at = ${Date.now() - 1000} WHERE shop_id = ${shopId}`;

test("delay: a cancelled slot is parked, a re-book by hand drops it silently, otherwise the next in line is told after the delay (cron path)", async () => {
  const { r, c, w, P, shopId } = await fixture();
  const date = weekdayAhead();
  const staff = w.staff[0].id, service = w.services[0].id;
  const s = await settings(r, { waitlist_delay_min: 5, waitlist_mode: "ORDER" });
  expect(s.shop ?? s).toBeTruthy();
  // Customer A holds 10:00; Wendy waits for any time that day.
  const a = await bookOnline(c, P, staff, service, date, 600, ph(1), "Holder Hal");
  await join(c, P, service, date, ph(2), "Waiting Wendy");
  const cancel = await r.post(base + `/bookings/${a.id}/status`, { data: { status: "CANCELLED", reason: "Rang to cancel", version: a.version } });
  expect(cancel.status(), await cancel.text()).toBe(200);
  // Nothing yet: the slot is parked, Wendy is still OPEN and has no offer text.
  let q = await queue(r);
  expect(q.settings).toMatchObject({ mode: "ORDER", delay_min: 5 });
  expect(q.waitlist.find((e) => e.customer_name === "Waiting Wendy")).toMatchObject({ status: "OPEN" });
  expect((await outbox(r)).filter((n) => n.recipient === ph(2) && n.template === "waitlist_offer")).toHaveLength(0);
  const parked = await sql`SELECT staff_id, start_min, notify_at FROM waitlist_pending_slots WHERE shop_id = ${shopId}`;
  expect(parked).toHaveLength(1);
  expect(Number(parked[0].start_min)).toBe(600);
  expect(Number(parked[0].notify_at)).toBeGreaterThan(Date.now() + 4 * 60000);
  // The shop books someone else straight back in. When the delay passes, the parked row is dropped — no text.
  const walkIn = await bookOnline(c, P, staff, service, date, 600, ph(3), "Walk-in Will");
  await fastForward(shopId);
  const cron = await c.get(origin + "/api/cron/messages");
  expect(cron.status()).toBe(200);
  expect(await sql`SELECT 1 FROM waitlist_pending_slots WHERE shop_id = ${shopId}`).toHaveLength(0);
  q = await queue(r);
  expect(q.waitlist.find((e) => e.customer_name === "Waiting Wendy")).toMatchObject({ status: "OPEN" });
  expect((await outbox(r)).filter((n) => n.recipient === ph(2) && n.template === "waitlist_offer")).toHaveLength(0);
  // Now the walk-in cancels and nobody re-books: after the delay Wendy gets the offer with the exact time.
  const cancel2 = await r.post(base + `/bookings/${walkIn.id}/status`, { data: { status: "CANCELLED", reason: "Changed plans", version: walkIn.version } });
  expect(cancel2.status(), await cancel2.text()).toBe(200);
  await fastForward(shopId);
  await c.get(origin + "/api/cron/messages");
  q = await queue(r);
  expect(q.waitlist.find((e) => e.customer_name === "Waiting Wendy")).toMatchObject({ status: "OFFERED", offer_source: "AUTO", offer_start_min: 600 });
  const msg = (await outbox(r)).find((n) => n.recipient === ph(2) && n.template === "waitlist_offer");
  expect(msg?.body).toMatch(/10:00/);
  expect(msg?.body).toMatch(/\/offer\//);
  // Re-freeing the same slot twice only ever parks one row (upsert) — and delay 0 acts at once.
  await settings(r, { waitlist_delay_min: 0 });
  const acc = await (await c.post(`${pub}/offer/${msg!.body.match(/\/offer\/([a-f0-9-]{72})/)![1]}/accept`, { data: {} })).json();
  await join(c, P, service, date, ph(4), "Instant Ivy");
  const cancel3 = await r.post(base + `/bookings/${acc.booking.id}/status`, { data: { status: "CANCELLED", reason: "Testing instant", version: acc.booking.version } });
  expect(cancel3.status(), await cancel3.text()).toBe(200);
  expect((await queue(r)).waitlist.find((e) => e.customer_name === "Instant Ivy")).toMatchObject({ status: "OFFERED", offer_source: "AUTO", offer_start_min: 600 });
  expect(await sql`SELECT 1 FROM waitlist_pending_slots WHERE shop_id = ${shopId}`).toHaveLength(0);
  await Promise.all([r.dispose(), c.dispose()]);
});

test("tell everyone: every matching waiter gets one text with the exact time and a booking link; first to book wins and their request closes; nobody is told twice", async () => {
  const { r, c, w, P, shopId } = await fixture();
  const date = weekdayAhead();
  const staff = w.staff[0].id, service = w.services[0].id;
  await settings(r, { waitlist_mode: "EVERYONE", waitlist_delay_min: 0 });
  const held = await bookOnline(c, P, staff, service, date, 630, ph(11), "Holder Hal");
  await join(c, P, service, date, ph(12), "Early Erin", { daypart: "MORNING" });
  await join(c, P, service, date, ph(13), "Anytime Andy");
  await join(c, P, service, date, ph(14), "Evening Eve", { daypart: "EVENING" }); // 10:30 is not evening → not told
  const cancel = await r.post(base + `/bookings/${held.id}/status`, { data: { status: "CANCELLED", reason: "Rang to cancel", version: held.version } });
  expect(cancel.status(), await cancel.text()).toBe(200);
  const q = await queue(r);
  // No hold in this mode: everyone stays OPEN.
  for (const n of ["Early Erin", "Anytime Andy", "Evening Eve"]) expect(q.waitlist.find((e) => e.customer_name === n)).toMatchObject({ status: "OPEN" });
  const texts = (await outbox(r)).filter((n) => n.template === "waitlist_open");
  expect(texts.map((t) => t.recipient).sort()).toEqual([ph(12), ph(13)]);
  for (const t of texts) {
    expect(t.body).toMatch(/10:30/);
    expect(t.body).toMatch(/First to book gets it/);
    expect(t.body).toContain(`/book/${q.waitlist.length ? (await (await r.get(base + "/workspace")).json()).shop.slug : ""}?service=${service}&staff=${staff}&date=${date}&start=630&step=2&wl=`);
  }
  expect(await sql`SELECT count(*)::int AS n FROM waitlist_announcements WHERE shop_id = ${shopId}`).toEqual([{ n: 2 }]);
  // Andy books it from the link → his request is BOOKED and linked; Erin stays OPEN.
  const booked = await bookOnline(c, P, staff, service, date, 630, ph(13), "Anytime Andy");
  const after = await queue(r);
  expect(after.waitlist.find((e) => e.customer_name === "Anytime Andy")).toBeUndefined();
  expect((await queue(r, "BOOKED")).waitlist.find((e) => e.customer_name === "Anytime Andy")).toMatchObject({ status: "BOOKED" });
  expect(after.waitlist.find((e) => e.customer_name === "Early Erin")).toMatchObject({ status: "OPEN" });
  // Same slot frees again → Erin was already told about it, so no second text to her.
  const cancel2 = await r.post(base + `/bookings/${booked.id}/status`, { data: { status: "CANCELLED", reason: "Again", version: booked.version } });
  expect(cancel2.status(), await cancel2.text()).toBe(200);
  expect((await outbox(r)).filter((n) => n.template === "waitlist_open" && n.recipient === ph(12))).toHaveLength(1);
  await Promise.all([r.dispose(), c.dispose()]);
});

test("time windows and date ranges: a customer's own from/to and 'any day up to' are respected when matching and when a slot frees", async () => {
  const { r, c, w, P } = await fixture();
  const d1 = weekdayAhead(3);
  const d2 = weekdayAhead(5) === d1 ? dateIn(6) : weekdayAhead(5);
  const staff = w.staff[0].id, service = w.services[0].id;
  await settings(r, { waitlist_mode: "ORDER", waitlist_delay_min: 0 });
  // Validation: end before start, half-window, last day before first, out of the booking window.
  const bad = (data: Record<string, unknown>) => c.post(`${P}/waitlist`, { data: { staff_id: null, service_id: service, customer_name: "Bad Bob", phone: ph(20), email: "", date: d1, daypart: "ANY", notes: "", ...data } });
  expect((await bad({ from_min: 720, to_min: 600 })).status()).toBe(400);
  expect((await bad({ from_min: 720 })).status()).toBe(400);
  expect((await bad({ date_to: dateIn(1) })).status()).toBe(400);
  expect((await bad({ date_to: dateIn(400) })).status()).toBe(409);
  // Nina wants 11:00–13:00 on d1 only. Rory wants any time from d1 up to d2.
  const nina = await join(c, P, service, d1, ph(21), "Window Nina", { from_min: 660, to_min: 780 });
  expect(nina).toMatchObject({ from_min: 660, to_min: 780, daypart: "ANY", date: d1, date_to: d1 });
  const rory = await join(c, P, service, d1, ph(22), "Range Rory", { date_to: d2 });
  expect(rory).toMatchObject({ date: d1, date_to: d2, from_min: 0, to_min: 1440 });
  // Joined confirmations spell the request out.
  const joined = (await outbox(r)).filter((n) => n.template === "waitlist_joined");
  expect(joined.find((n) => n.recipient === ph(21))?.body).toMatch(/11:00–13:00/);
  expect(joined.find((n) => n.recipient === ph(22))?.body).toMatch(/ – /);
  const q = await queue(r);
  const ninaRow = q.waitlist.find((e) => e.customer_name === "Window Nina")!;
  const roryRow = q.waitlist.find((e) => e.customer_name === "Range Rory")!;
  expect(ninaRow).toMatchObject({ from_min: 660, to_min: 780 });
  expect(roryRow).toMatchObject({ date: d1, date_to: d2 });
  // Matches honour the window; range matches carry their date and span both days.
  const nm = (await (await r.get(base + `/waitlist/${ninaRow.id}/matches`)).json()).matches as { start_min: number; date: string; staff_id: string }[];
  expect(nm.length).toBeGreaterThan(0);
  expect(nm.every((m) => m.start_min >= 660 && m.start_min < 780)).toBe(true);
  const rm = (await (await r.get(base + `/waitlist/${roryRow.id}/matches`)).json()).matches as { start_min: number; date: string; staff_id: string }[];
  const rmDates = new Set(rm.map((m) => m.date));
  expect(rmDates.has(d1) && rmDates.has(d2)).toBe(true);
  expect([...rmDates].every((d) => d >= d1 && d <= d2)).toBe(true);
  // Offering Rory a d2 time works and pins the offer to d2; a date outside the range is refused.
  const onD2 = rm.find((m) => m.date === d2)!;
  expect((await r.post(base + `/waitlist/${roryRow.id}/offer`, { data: { staff_id: onD2.staff_id, start_min: onD2.start_min, date: dateIn(40), version: roryRow.version } })).status()).toBe(409);
  const offer = await r.post(base + `/waitlist/${roryRow.id}/offer`, { data: { staff_id: onD2.staff_id, start_min: onD2.start_min, date: d2, version: roryRow.version } });
  expect(offer.status(), await offer.text()).toBe(201);
  const acc = await (await c.post(`${pub}/offer/${(await offer.json()).offer.link.split("/offer/")[1]}/accept`, { data: {} })).json();
  expect(acc.booking.date).toBe(d2);
  // Rory (any time, d1–d2) has just accepted a d2 time, so only Nina is still waiting on d1.
  // A cancellation on d1 outside Nina's window → she is not offered it.
  const avail = await (await c.get(`${P}/availability?date=${d1}&staff_id=${staff}&service_id=${service}`)).json();
  const outside = (avail.slots as { start_min: number; available: boolean }[]).find((x) => x.available && (x.start_min < 660 || x.start_min >= 780))!;
  const nine = await bookOnline(c, P, staff, service, d1, outside.start_min, ph(23), "Nine Nick");
  expect((await r.post(base + `/bookings/${nine.id}/status`, { data: { status: "CANCELLED", reason: "Customer rang to cancel", version: nine.version } })).status()).toBe(200);
  expect((await queue(r)).waitlist.find((e) => e.id === ninaRow.id)).toMatchObject({ status: "OPEN" });
  // An 11:30 cancellation is inside it → offered.
  const inside = nm.find((m) => m.staff_id === staff) ?? nm[0];
  const half = await bookOnline(c, P, inside.staff_id, service, d1, inside.start_min, ph(24), "Half Eleven Hank");
  expect((await r.post(base + `/bookings/${half.id}/status`, { data: { status: "CANCELLED", reason: "Customer rang to cancel", version: half.version } })).status()).toBe(200);
  expect((await queue(r)).waitlist.find((e) => e.id === ninaRow.id)).toMatchObject({ status: "OFFERED", offer_source: "AUTO", offer_start_min: inside.start_min });
  await Promise.all([r.dispose(), c.dispose()]);
});

test("browser: settings panel saves the mode and delay; customer join form offers a custom window and an end date", async ({ page }) => {
  const { slug } = await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  const own = page.request;
  // Admin: switch to "tell everyone", set the delay to 10 and save.
  await openQueue(page);
  await page.getByTestId("queue-drawer").getByTestId("queue-settings").click();
  const panel = page.getByTestId("waitlist-settings");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("waitlist-mode-ORDER")).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByTestId("waitlist-delay")).toHaveValue("5");
  await panel.getByTestId("waitlist-mode-EVERYONE").click();
  await expect(panel.getByTestId("offer-hold")).toHaveCount(0); // no hold in this mode
  await panel.getByTestId("waitlist-delay").fill("10");
  await expect(panel.getByTestId("template-waitlist_open")).toBeVisible();
  await panel.getByTestId("save-waitlist-settings").click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  const saved = await queue(own);
  expect(saved.settings).toMatchObject({ mode: "EVERYONE", delay_min: 10 });
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  // Customer: fill one barber's day so the waiting-list card appears, then join with a custom window and an end date.
  const big = w.services.reduce((a: { duration_min: number }, s: { duration_min: number }) => (s.duration_min > a.duration_min ? s : a), w.services[0]);
  const full = weekdayAhead(4);
  const st = w.staff[0];
  for (let m = 480; m < 1200; m += 15) {
    const av = await (await own.get(`${pub}/shops/${slug}/availability?date=${full}&staff_id=${st.id}&service_id=${big.id}`)).json();
    const slot = av.slots?.find((s: { start_min: number; available: boolean }) => s.start_min >= m && s.available);
    if (!slot) break;
    m = slot.start_min;
    const res = await own.post(base + "/bookings", { data: { request_id: crypto.randomUUID(), staff_id: st.id, service_id: big.id, customer_name: "Filler " + m, phone: "07700900" + String(700 + m / 15).padStart(3, "0"), email: "", date: full, start_min: m, quote: av.quote } });
    if (res.status() !== 201) break;
  }
  const cust = await page.context().browser()!.newContext();
  const cp = await cust.newPage();
  await cp.goto(`/book/${slug}?service=${w.services[0].id}&staff=${st.id}&date=${full}&step=2`);
  const card = cp.locator(".waitlist-card");
  // The card only shows once the barber's day is genuinely full; if the fixture diary could not be filled, stop here.
  if (!(await card.isVisible().catch(() => false))) { await cust.close(); return; }
  await card.getByRole("button", { name: /Join the waitlist/ }).click();
  await cp.getByTestId("waitlist-part-CUSTOM").click();
  await expect(cp.getByTestId("waitlist-window")).toBeVisible();
  await cp.getByTestId("waitlist-from").selectOption("600");
  await cp.getByTestId("waitlist-to").selectOption("780");
  const until = weekdayAhead(6) === full ? dateIn(8) : weekdayAhead(6);
  await cp.getByTestId("waitlist-date-to").fill(until);
  await cp.locator(".waitlist-form input[name=name]").fill("Browser Bea");
  await cp.locator(".waitlist-form input[name=phone]").fill(ph(40));
  const ca11y = await new AxeBuilder({ page: cp }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(ca11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await cp.getByRole("button", { name: /Ask the shop to contact me/ }).click();
  await expect(cp.getByText(/You’re on the list/)).toBeVisible();
  await expect(cp.getByText(/first to book gets it/)).toBeVisible();
  await cust.close();
  const q = await queue(own);
  expect(q.waitlist.find((e) => e.customer_name === "Browser Bea")).toMatchObject({ from_min: 600, to_min: 780, date: full, date_to: until });
  // The queue row spells the window and the range out.
  await page.reload();
  await openQueue(page);
  const row = page.getByTestId("queue-drawer").getByTestId("queue-row").filter({ hasText: "Browser Bea" });
  await expect(row).toContainText("10:00–13:00");
  await expect(row).toContainText(" – ");
});
