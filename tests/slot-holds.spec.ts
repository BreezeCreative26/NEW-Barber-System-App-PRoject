// Online slot holds: the time a customer taps is held for them (5 minutes at most, 2 minutes after
// leaving). Other customers don't see it, the shop sees "Booking in progress", and the shop can book
// over it after a warning, in which case the customer is told it has gone. The only direct DB touch
// fast-forwards the 5-minute clock.
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import "dotenv/config";
import { openFixtureShop, refreshView, base, origin } from "./fixture";

const sql = postgres(process.env.DATABASE_URL || process.env.DIRECT_URL || "postgresql://postgres:postgres@127.0.0.1:5432/ollo", { max: 2, idle_timeout: 20, connect_timeout: 10 });
test.afterAll(() => sql.end());
const pub = (slug: string) => `${origin}/api/public/shops/${slug}`;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// The page checks in every 20 s; nudge it now instead of waiting.
const nudge = (p: Page) => p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

async function setup(page: Page) {
  const fx = await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  const svc = w.services[0], staff = w.staff[0];
  const days = (await (await page.request.get(`${pub(fx.slug)}/days?service_id=${svc.id}&staff_id=${staff.id}`)).json()).days;
  const date = days.slice(1).find((d: { closed: boolean; beyond: boolean; available: number }) => !d.closed && !d.beyond && d.available > 8).date as string;
  return { fx, w, svc, staff, date };
}

test("a tapped time is held: hidden from others, shown to the shop, staff warned, customer told when it goes", async ({ page, browser }) => {
  test.setTimeout(150000);
  const { fx, svc, staff, date } = await setup(page);
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(`/book/${fx.slug}?service=${svc.id}&staff=${staff.id}&date=${date}&step=2`);
  const times = customer.getByRole("group", { name: "Choose an appointment time" }).locator(".time-slots button:not(.time-more):not([disabled])");
  await expect(times.first()).toBeVisible();
  const pick = times.nth(2);
  const label = (await pick.innerText()).trim().slice(0, 5);
  const start = Number(label.slice(0, 2)) * 60 + Number(label.slice(3, 5));
  await pick.click();
  const pill = customer.getByTestId("hold-pill");
  await expect(pill).toContainText(`${label} is held for you`);
  await expect(pill).toContainText(/[45]:\d\d/);

  // Another customer (no hold key of theirs on it) doesn't see the time.
  const other = await page.request.get(`${pub(fx.slug)}/availability?service_id=${svc.id}&date=${date}&staff_id=${staff.id}`, { headers: { "x-hold-key": "other-customer-0000000000" } });
  const slots = (await other.json()).slots as { start_min: number; available: boolean }[];
  expect(slots.find((s) => s.start_min === start)?.available).toBe(false);
  const steal = await page.request.post(`${pub(fx.slug)}/holds`, { headers: { Origin: origin, "x-hold-key": "other-customer-0000000000" }, data: { staff_id: staff.id, service_id: svc.id, date, start_min: start } });
  expect(steal.status()).toBe(409);

  // The shop sees "Booking in progress" on that barber's column.
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await refreshView(page);
  const block = page.getByTestId("calendar-hold");
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("Booking in progress");
  await expect(block).toContainText(`${label} · ${svc.name}`);
  await expect(block).toContainText(/\d:\d\d left/);

  // Clicking it explains who/what and offers to book over it; the booking form then saves over the hold.
  await block.click();
  await expect(page.getByRole("dialog").getByText("Online booking in progress")).toBeVisible();
  await page.getByRole("button", { name: "Book over it" }).click();
  const dialog = page.getByRole("dialog", { name: /booking/i }).last();
  await dialog.getByTestId("booking-walkin").click();
  await dialog.getByRole("button", { name: "Review appointment" }).click();
  await dialog.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByTestId("calendar-hold")).toHaveCount(0);
  const day = await (await page.request.get(`${base}/bookings?date=${date}`)).json();
  expect(day.bookings.some((b: { staff_id: string; start_min: number; status: string }) => b.staff_id === staff.id && b.start_min === start && b.status === "CONFIRMED")).toBe(true);

  // The customer is told it has gone, and the time is no longer offered.
  await nudge(customer);
  await expect(customer.getByTestId("hold-gone")).toContainText(`Sorry, ${label} with ${staff.name.split(" ")[0]} has just gone`);
  await expect(customer.getByTestId("hold-pill")).toHaveCount(0);
  await expect(times.filter({ hasText: new RegExp(`^${label}`) })).toHaveCount(0);
  await customer.context().close();
});

test("staff booking over a held time without confirming is refused with a warning code", async ({ page }) => {
  test.setTimeout(90000);
  const { fx, svc, staff, date } = await setup(page);
  const av = await (await page.request.get(`${pub(fx.slug)}/availability?service_id=${svc.id}&date=${date}&staff_id=${staff.id}`)).json();
  const start = av.slots.find((s: { available: boolean }) => s.available).start_min;
  const held = await page.request.post(`${pub(fx.slug)}/holds`, { headers: { Origin: origin, "x-hold-key": "holder-customer-000000000" }, data: { staff_id: staff.id, service_id: svc.id, date, start_min: start } });
  expect(held.status(), await held.text()).toBe(201);
  const body = { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Walk-in", phone: "", notes: "", date, start_min: start, source: "WALK_IN", addon_ids: [], quote: av.quote };
  const refused = await page.request.post(`${base}/bookings`, { headers: { Origin: origin }, data: body });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toBe("slot_held");
  const forced = await page.request.post(`${base}/bookings`, { headers: { Origin: origin }, data: { ...body, request_id: crypto.randomUUID(), force: true } });
  expect(forced.status(), await forced.text()).toBe(201);
  const ping = await (await page.request.post(`${pub(fx.slug)}/holds/ping`, { headers: { Origin: origin, "x-hold-key": "holder-customer-000000000" } })).json();
  expect(ping.status).toBe("taken");
});

test("after 5 minutes the hold ends, the customer is told and can hold it again if it's still free", async ({ page, browser }) => {
  test.setTimeout(120000);
  const { fx, svc, staff, date } = await setup(page);
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(`/book/${fx.slug}?service=${svc.id}&staff=${staff.id}&date=${date}&step=2`);
  const times = customer.getByRole("group", { name: "Choose an appointment time" }).locator(".time-slots button:not(.time-more):not([disabled])");
  await expect(times.first()).toBeVisible();
  const label = (await times.nth(1).innerText()).trim().slice(0, 5);
  await times.nth(1).click();
  await expect(customer.getByTestId("hold-pill")).toBeVisible();
  // Fast-forward the 5-minute clock.
  await sql`UPDATE slot_holds SET expires_at=${Date.now() - 1000} WHERE shop_id=(SELECT id FROM shops WHERE slug=${fx.slug})`;
  await nudge(customer);
  const notice = customer.getByTestId("hold-expired");
  await expect(notice).toContainText(`We couldn't hold ${label} any longer`);
  await expect(customer.getByTestId("hold-pill")).toHaveCount(0);
  await notice.getByTestId("hold-again").click();
  await expect(customer.getByTestId("hold-pill")).toContainText(`${label} is held for you`);
  await customer.context().close();
});

test("leaving the page keeps the time 2 more minutes, then frees it", async ({ page }) => {
  test.setTimeout(90000);
  const { fx, svc, staff, date } = await setup(page);
  const key = { Origin: origin, "x-hold-key": "leaving-customer-00000000" };
  const av = await (await page.request.get(`${pub(fx.slug)}/availability?service_id=${svc.id}&date=${date}&staff_id=${staff.id}`)).json();
  const start = av.slots.find((s: { available: boolean }) => s.available).start_min;
  expect((await page.request.post(`${pub(fx.slug)}/holds`, { headers: key, data: { staff_id: staff.id, service_id: svc.id, date, start_min: start } })).status()).toBe(201);
  const left = await (await page.request.post(`${pub(fx.slug)}/holds/left`, { headers: key })).json();
  expect(left.keeps_ms).toBe(120000);
  const free = async () => ((await (await page.request.get(`${pub(fx.slug)}/availability?service_id=${svc.id}&date=${date}&staff_id=${staff.id}`, { headers: { "x-hold-key": "someone-else-00000000000" } })).json()).slots as { start_min: number; available: boolean }[]).find((s) => s.start_min === start)?.available;
  expect(await free()).toBe(false);
  const w = await (await page.request.get(base + "/workspace")).json();
  expect(w.holds.find((h: { start_min: number }) => h.start_min === start)?.left_at).toBeTruthy();
  // 2 minutes pass without the page coming back.
  await sql`UPDATE slot_holds SET left_at=${Date.now() - 130000}, seen_at=${Date.now() - 130000} WHERE shop_id=(SELECT id FROM shops WHERE slug=${fx.slug})`;
  expect(await free()).toBe(true);
  expect(hhmm(start)).toMatch(/^\d\d:\d\d$/);
});
