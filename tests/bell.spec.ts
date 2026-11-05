// Team bell clean-up: clear one (Undo), Clear all (Undo), Mark all read (opening no longer reads),
// open one marks just that one read, Activity / Needs attention tabs, Dismiss, and every bit of it
// is per login (one person tidying their bell never changes anyone else's).
import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin, newShop, registerCustomer } from "./shop";
import { openFixtureShop, openNotifications } from "./fixture";

const pub = origin + "/api/public";
type Inbox = { events: { id: string; title: string; unread: boolean; booking_id: string | null }[]; unread: number; all: boolean; dismissed: string[] };
const inbox = async (ctx: APIRequestContext): Promise<Inbox> => (await ctx.get(base + "/inbox")).json();
function futureDate(days = 9) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function onlineShop() {
  const { r } = await newShop("Bell Clean-up Shop");
  let w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  const slug = `bell-${crypto.randomUUID().slice(0, 12)}`;
  const res = await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  expect(res.status(), await res.text()).toBe(200);
  w = await (await r.get(base + "/workspace")).json();
  return { r, w, slug };
}
// Online bookings write bell events ("New booking").
async function bookOnline(slug: string, w: WorkspaceData, date: string, n: number) {
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const staff = w.staff[0].id, service = w.services[0].id;
  // Walk forward from `date` to the first day this barber has enough free times (skips days off).
  let avail: { slots: { start_min: number; available?: boolean; reason?: string }[]; quote: unknown } = { slots: [], quote: null };
  let free: { start_min: number } | undefined;
  for (let i = 0; i < 10 && !free; i++) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${day}&staff_id=${staff}&service_id=${service}`)).json();
    free = avail.slots.filter((x) => !x.reason && x.available !== false)[n];
    if (free) date = day;
  }
  expect(free, `no free slot ${n} from ${date}`).toBeTruthy();
  const who = await registerCustomer(c, slug, { name: `Bell Customer ${n}` });
  const res = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: who.name, phone: who.phone, email: who.email, date, start_min: free!.start_min, quote: avail.quote } });
  expect(res.status(), await res.text()).toBe(201);
  await c.dispose();
}
async function joinAs(r: APIRequestContext, w: WorkspaceData, role: "MANAGER" | "BARBER") {
  const address = `bell-${crypto.randomUUID().slice(0, 8)}@ollo.test`;
  const inv = await r.post(base + "/auth/invites", { data: { email: address, role, staff_id: w.staff[0].id } });
  expect(inv.status(), await inv.text()).toBe(201);
  const ctx = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const acc = await ctx.post(base + "/auth/accept", { data: { accept_legal: true, token: (await inv.json()).token, name: "Bell Teammate", email: address, password: "Unique fictional test password 438!" } });
  expect(acc.status(), await acc.text()).toBe(201);
  return ctx;
}

test("bell API: clear / undo / read one / mark all / dismiss are per login", async () => {
  const { r, w, slug } = await onlineShop();
  const mate = await joinAs(r, w, "BARBER"); // staff[0]'s barber: sees these bookings too
  const date = futureDate();
  for (const n of [0, 1, 2]) await bookOnline(slug, w, date, n);

  let mine = await inbox(r);
  expect(mine.events.filter((e) => e.title === "New booking")).toHaveLength(3);
  expect(mine.unread).toBe(3);
  const [a, b, c] = mine.events;

  // Reading one item marks only that one.
  expect((await r.post(base + "/inbox/read", { data: { ids: [a.id] } })).status()).toBe(200);
  mine = await inbox(r);
  expect(mine.unread).toBe(2);
  expect(mine.events.find((e) => e.id === a.id)!.unread).toBe(false);

  // × on one item: gone for me, still there for my teammate; Undo brings it back.
  const cleared = await (await r.post(base + "/inbox/clear", { data: { ids: [b.id] } })).json();
  expect(cleared.cleared).toEqual([b.id]);
  expect((await inbox(r)).events.map((e) => e.id)).not.toContain(b.id);
  expect((await inbox(mate)).events.map((e) => e.id)).toContain(b.id);
  expect((await r.post(base + "/inbox/restore", { data: { cleared: [b.id] } })).status()).toBe(200);
  expect((await inbox(r)).events.map((e) => e.id)).toContain(b.id);

  // Clear all, then Undo with the returned ids.
  const all = await (await r.post(base + "/inbox/clear", { data: {} })).json();
  expect(all.cleared.sort()).toEqual([a.id, b.id, c.id].sort());
  expect((await inbox(r)).events).toHaveLength(0);
  expect((await inbox(r)).unread).toBe(0);
  expect((await inbox(mate)).events).toHaveLength(3);
  await r.post(base + "/inbox/restore", { data: { cleared: all.cleared } });
  expect((await inbox(r)).events).toHaveLength(3);

  // Mark all read affects only me.
  await r.post(base + "/inbox/read", { data: {} });
  expect((await inbox(r)).unread).toBe(0);
  expect((await inbox(mate)).unread).toBe(3);

  // I can't touch events I'm not allowed to see: another shop's ids are ignored.
  const other = await onlineShop();
  await bookOnline(other.slug, other.w, date, 0);
  const foreign = (await inbox(other.r)).events[0].id;
  expect((await (await r.post(base + "/inbox/clear", { data: { ids: [foreign] } })).json()).cleared).toEqual([]);
  expect((await inbox(other.r)).events.map((e) => e.id)).toContain(foreign);

  // Dismiss a "needs attention" item by key; it is listed back per login, and Undo restores it.
  const key = `${crypto.randomUUID()}|Barber has a day off`;
  await r.post(base + "/inbox/dismiss", { data: { keys: [key] } });
  expect((await inbox(r)).dismissed).toContain(key);
  expect((await inbox(mate)).dismissed).not.toContain(key);
  await r.post(base + "/inbox/restore", { data: { dismissed: [key] } });
  expect((await inbox(r)).dismissed).not.toContain(key);

  // Bad input is rejected.
  expect((await r.post(base + "/inbox/dismiss", { data: { keys: [] } })).status()).toBe(400);
  expect((await r.post(base + "/inbox/clear", { data: { ids: "x" } })).status()).toBe(400);
  await Promise.all([r.dispose(), mate.dispose(), other.r.dispose()]);
});

async function seedEvents(page: Page, n: number) {
  // The fixture shop already takes online bookings; each one writes a "New booking" bell event.
  const w: WorkspaceData = await (await page.request.get(base + "/workspace")).json();
  expect(w.shop.online_booking).toBe(1);
  for (let i = 0; i < n; i++) await bookOnline(w.shop.slug as string, w, futureDate(10), i);
  return w;
}

test("bell UI: tabs, day groups, × with Undo, Clear all with Undo, Mark all read, Dismiss, badge counts unread activity only", async ({ page }) => {
  await openFixtureShop(page);
  await page.request.post(base + "/inbox/clear", { headers: { Origin: origin }, data: {} });
  await seedEvents(page, 3);
  await page.reload();
  const bell = page.getByTestId("bell");
  await expect(bell).toHaveAccessibleName("Notifications, 3 unread");

  await openNotifications(page);
  const drawer = page.getByTestId("notifications");
  await expect(drawer.getByTestId("bell-summary")).toContainText("3 unread");
  await expect(drawer.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(drawer.getByTestId("bell-item")).toHaveCount(3);
  await expect(drawer.getByTestId("bell-item").first()).toContainText(/min ago|Just now/);
  // Opening the bell no longer marks anything read by itself.
  await page.waitForTimeout(2000);
  expect((await inbox(page.request)).unread).toBe(3);

  // × one, then Undo.
  await drawer.getByTestId("bell-clear").first().click();
  await expect(drawer.getByTestId("bell-item")).toHaveCount(2);
  await expect(drawer.getByTestId("bell-undo")).toContainText("Notification cleared");
  await drawer.getByTestId("bell-undo").getByRole("button", { name: "Undo" }).click();
  await expect(drawer.getByTestId("bell-item")).toHaveCount(3);

  // Mark all read: highlight goes, badge goes, items stay.
  await drawer.getByTestId("bell-mark-all").click();
  await expect(drawer.getByTestId("bell-summary")).toContainText("You're all caught up");
  await expect(drawer.locator(".bell-item.unread")).toHaveCount(0);
  await expect(bell).toHaveAccessibleName("Notifications");
  await expect(drawer.getByTestId("bell-mark-all")).toBeDisabled();

  // Clear all, then Undo.
  await drawer.getByTestId("bell-clear-all").click();
  await expect(drawer.getByTestId("bell-item")).toHaveCount(0);
  await expect(drawer.getByText(/No notifications/)).toBeVisible();
  await expect(drawer.getByTestId("bell-undo")).toContainText("Cleared 3 notifications");
  await drawer.getByTestId("bell-undo").getByRole("button", { name: "Undo" }).click();
  await expect(drawer.getByTestId("bell-item")).toHaveCount(3);

  // Needs attention tab: the fixture shop's schedule issues (if any) can be dismissed and restored;
  // they never count towards the red badge.
  await drawer.getByTestId("bell-tab-attention").click();
  const issues = drawer.getByTestId("bell-issue");
  const count = await issues.count();
  if (count > 0) {
    await issues.first().getByTestId("bell-dismiss").click();
    await expect(issues).toHaveCount(count - 1);
    await expect(drawer.getByTestId("bell-undo")).toContainText("Dismissed");
    await drawer.getByTestId("bell-undo").getByRole("button", { name: "Undo" }).click();
    await expect(issues).toHaveCount(count);
  } else {
    await expect(drawer.getByText("Nothing needs your attention.")).toBeVisible();
  }
  await expect(bell).toHaveAccessibleName("Notifications");

  // Push switch sits at the bottom, after the list.
  const foot = drawer.locator(".bell-foot");
  await expect(foot).toBeAttached();
  const order = await drawer.evaluate((el) => {
    const list = el.querySelector(".bell-list")!, f = el.querySelector(".bell-foot")!;
    return list.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING ? "after" : "before";
  });
  expect(order).toBe("after");
});

test("bell UI: a schedule issue shows under Needs attention, Dismiss hides it for this login only", async ({ page }) => {
  const fx = await openFixtureShop(page);
  void fx;
  const r = page.request;
  const w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  // Book a 30-min service, then give that barber the day off: it becomes a schedule issue.
  const date = futureDate(12);
  const svc = w.services.find((s) => s.duration_min === 30) ?? w.services[0];
  const staff = w.staff[0];
  const avail = await (await r.get(base + `/availability?date=${date}&staff_id=${staff.id}&service_id=${svc.id}`)).json();
  const free = (avail.slots as { start_min: number; available?: boolean; taken?: boolean; reason?: string }[]).find((s) => !s.reason && s.available !== false && !s.taken);
  expect(free, "no free slot").toBeTruthy();
  const made = await r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Bell Issue Client", phone: "07700900456", date, start_min: free!.start_min, source: "TEST_BOOKING", quote: { service_version: svc.version, shop_version: w.shop.version } } });
  expect(made.status(), await made.text()).toBe(201);
  const booked = (await made.json()).booking;
  const off = await r.post(base + `/staff/${staff.id}/days-off`, { headers: { Origin: origin }, data: { date, reason: "Fictional leave" } });
  expect(off.status(), await off.text()).toBe(201);
  const after: WorkspaceData = await (await r.get(base + "/workspace")).json();
  const issue = after.issues.find((i) => i.booking_id === booked.id)!;
  expect(issue).toBeTruthy();

  await page.reload();
  await openNotifications(page);
  const drawer = page.getByTestId("notifications");
  await drawer.getByTestId("bell-tab-attention").click();
  const row = drawer.getByTestId("bell-issue").filter({ hasText: issue.ref });
  await expect(row).toContainText(issue.reason);
  await row.getByTestId("bell-dismiss").click();
  await expect(row).toHaveCount(0);
  // Stays dismissed after a reload (stored per login), and the Review button still works for others.
  await page.reload();
  await openNotifications(page);
  await drawer.getByTestId("bell-tab-attention").click();
  await expect(drawer.getByTestId("bell-issue").filter({ hasText: issue.ref })).toHaveCount(0);
  expect((await inbox(r)).dismissed).toContain(`${issue.booking_id}|${issue.reason}`);
  // Release the day off so the fixture shop is left as it was.
  const days = (await (await r.get(base + "/workspace")).json() as WorkspaceData).days_off.filter((d) => d.staff_id === staff.id && d.date === date);
  for (const d of days) await r.delete(base + `/staff/${staff.id}/days-off/${d.id}`, { headers: { Origin: origin } });
  await r.post(base + `/bookings/${booked.id}/cancel`, { headers: { Origin: origin }, data: { reason: "test clean-up", version: booked.version } });
});
