// Messages: the outbox is a real delivery queue. Without provider keys the sandbox uses the
// "mailbox" provider (status SENT, nothing leaves), so these tests assert the queue contract:
// what gets enqueued, in which channels, branded for the shop, idempotent reminders, owner
// settings, test send, resend and the cron route. Every test creates its own fictional shop.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin, newShop, enterNewShop } from "./shop";
import { section } from "./fixture";

const pub = origin + "/api/public";
type Note = {
  id: string; channel: "SMS" | "EMAIL"; recipient: string; template: string; body: string; subject: string;
  status: string; provider: string; related_id: string; attempts: number; error: string; status_note: string;
};
type Outbox = {
  notifications: Note[];
  counts_30d: Record<string, number>;
  providers: { email: { provider: string }; sms: { provider: string } };
  messaging: { msg_sms: number; msg_email: number; msg_reminders: number; msg_reminder_hours: number; msg_reply_to: string; msg_sms_sender: string };
};

function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function onlineShop(name = "Messaging Test Shop") {
  const { r, shop_id } = await newShop(name);
  let w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  const slug = `msg-${crypto.randomUUID().slice(0, 12)}`;
  const res = await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  expect(res.status(), await res.text()).toBe(200);
  w = await (await r.get(base + "/workspace")).json();
  return { r, w, slug, shop_id };
}
async function customer() {
  return request.newContext({ extraHTTPHeaders: { Origin: origin } });
}
async function outbox(r: APIRequestContext): Promise<Outbox> {
  const res = await r.get(base + "/notifications");
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
async function bookOnline(c: APIRequestContext, slug: string, w: WorkspaceData, date: string, start_min = 600, extra: Record<string, unknown> = {}) {
  const staff = w.staff[0].id, service = w.services[0].id;
  const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  // Prefer the requested minute; fall back to the first free slot so a demo-seed appointment on
  // that day cannot turn this into a slot_taken failure.
  const wanted = avail.slots.find((x: { start_min: number; reason?: string }) => x.start_min === start_min && !x.reason);
  const free = wanted ?? avail.slots.find((x: { reason?: string }) => !x.reason);
  expect(free, `no free slot on ${date}`).toBeTruthy();
  const data = { request_id: crypto.randomUUID(), staff_id: staff, service_id: service, customer_name: "Message Customer", phone: "07700 900333", email: "msg-customer@example.test", date, start_min: free.start_min, quote: avail.quote, ...extra };
  const res = await c.post(`${pub}/shops/${slug}/bookings`, { data });
  expect(res.status(), await res.text()).toBe(201);
  return res.json() as Promise<{ booking: { id: string; version: number }; manage_token: string; sent_to: string[] }>;
}

test("booking created → confirmation queued on SMS and email, shop-branded, never OLLO; cancel via manage link notifies", async () => {
  const { r, w, slug } = await onlineShop("Northline Test Barbers");
  const c = await customer();
  const created = await bookOnline(c, slug, w, futureDate(8));
  expect(created.sent_to.sort()).toEqual(["EMAIL", "SMS"]);

  const box = await outbox(r);
  const mine = box.notifications.filter((n) => n.related_id === created.booking.id && n.template === "booking_confirmed");
  expect(mine.map((n) => n.channel).sort()).toEqual(["EMAIL", "SMS"]);
  for (const n of mine) {
    expect(["SENT", "QUEUED"]).toContain(n.status);
    expect(n.body).toContain("Northline Test Barbers");
    expect(n.body).not.toMatch(/OLLO/i);
    expect(n.body).toContain("/manage/");
  }
  const email = mine.find((n) => n.channel === "EMAIL")!;
  expect(email.recipient).toBe("msg-customer@example.test");
  expect(email.subject).toMatch(/Northline Test Barbers/);
  // Full read includes the rendered HTML, branded for the shop.
  const full = await (await r.get(base + `/notifications/${email.id}`)).json();
  expect(full.notification.html).toContain("Northline Test Barbers");
  expect(full.notification.html).not.toMatch(/OLLO/i);
  expect(box.counts_30d.SENT ?? 0).toBeGreaterThanOrEqual(2);
  expect(box.providers.email.provider).toMatch(/^(mailbox|resend)$/);
  expect(box.providers.sms.provider).toMatch(/^(mailbox|twilio)$/);

  // Cancelling through the manage link writes a cancellation message.
  const cancel = await c.post(`${pub}/manage/${created.manage_token}/cancel`, { data: { version: created.booking.version } });
  expect(cancel.status(), await cancel.text()).toBe(200);
  const after = await outbox(r);
  const cancelled = after.notifications.filter((n) => n.related_id === created.booking.id && n.template === "booking_cancelled");
  expect(cancelled.length).toBeGreaterThanOrEqual(1);
  expect(cancelled[0].body).toContain("Northline Test Barbers");
});

test("channel toggles are respected: SMS off → email only; both off → nothing queued but booking still succeeds", async () => {
  const { r, w, slug } = await onlineShop();
  const c = await customer();
  const set = async (msg_sms: 0 | 1, msg_email: 0 | 1) => {
    const res = await r.put(base + "/shop/messaging", { data: { msg_sms, msg_email, msg_reminders: 1, msg_reminder_hours: 24, msg_reply_to: "", msg_sms_sender: "" } });
    expect(res.status(), await res.text()).toBe(200);
  };
  await set(0, 1);
  const a = await bookOnline(c, slug, w, futureDate(9), 600);
  expect(a.sent_to).toEqual(["EMAIL"]);
  let box = await outbox(r);
  expect(box.messaging.msg_sms).toBe(0);
  expect(box.notifications.filter((n) => n.related_id === a.booking.id).map((n) => n.channel)).toEqual(["EMAIL"]);

  await set(0, 0);
  const b = await bookOnline(c, slug, w, futureDate(10), 600);
  expect(b.sent_to).toEqual([]);
  box = await outbox(r);
  expect(box.notifications.filter((n) => n.related_id === b.booking.id)).toEqual([]);

  // Validation: reply-to must be an email, sender max 11 alphanumerics.
  const bad = await r.put(base + "/shop/messaging", { data: { msg_sms: 1, msg_email: 1, msg_reminders: 1, msg_reminder_hours: 24, msg_reply_to: "not-an-email", msg_sms_sender: "Way Too Long Sender!" } });
  expect(bad.status()).toBe(400);
});

test("reminders sweep is idempotent: one reminder per booking per window, honours the shop's reminder hours", async () => {
  const { r, w, slug } = await onlineShop();
  const c = await customer();
  // 24h reminder window is (h-1, h] hours ahead. Book something 23.5h from now on a 15-minute grid.
  const target = new Date(Date.now() + 23.5 * 3600000);
  const date = target.toISOString().slice(0, 10);
  if (new Date(date + "T00:00:00Z").getUTCDay() === 0) test.skip(true, "target day is Sunday (shop closed)");
  // Pick the first available slot on that day nearest the target — availability tells us what's open.
  const staff = w.staff[0].id, service = w.services[0].id;
  const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const slots: number[] = (avail.slots as { start_min: number; available: boolean }[]).filter((s) => s.available).map((s) => s.start_min);
  test.skip(slots.length === 0, "no open slot on the target day");
  const wantMin = target.getUTCHours() * 60 + target.getUTCMinutes();
  const start_min = slots.reduce((best, s) => (Math.abs(s - wantMin) < Math.abs(best - wantMin) ? s : best), slots[0]);
  // Only a window-hit if the slot lands 23–24h ahead; otherwise we still verify idempotency (0 then 0).
  const created = await bookOnline(c, slug, w, date, start_min);

  const first = await (await r.post(base + "/notifications/sweep", { data: {} })).json();
  const second = await (await r.post(base + "/notifications/sweep", { data: {} })).json();
  expect(second.reminders.queued).toBe(0);
  const box = await outbox(r);
  const reminders = box.notifications.filter((n) => n.related_id === created.booking.id && n.template === "booking_reminder");
  // Never more than one per channel, regardless of how many sweeps ran.
  expect(reminders.filter((n) => n.channel === "SMS").length).toBeLessThanOrEqual(1);
  expect(reminders.filter((n) => n.channel === "EMAIL").length).toBeLessThanOrEqual(1);
  // The sweep is platform-wide (other shops in parallel tests count too); only assert when the
  // booked slot actually sits inside this shop's 23–24h window.
  const startsAt = new Date(`${date}T00:00:00Z`).getTime() + start_min * 60000;
  const hoursAhead = (startsAt - Date.now()) / 3600000;
  if (first.reminders.queued > 0 && hoursAhead > 23 && hoursAhead <= 24) {
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    expect(reminders[0].body).toMatch(/tomorrow|reminder|see you/i);
    expect(reminders[0].body).toContain(`/${slug}/me`);
  }
  // Reminders off → sweep queues nothing for this shop.
  await r.put(base + "/shop/messaging", { data: { msg_sms: 1, msg_email: 1, msg_reminders: 0, msg_reminder_hours: 24, msg_reply_to: "", msg_sms_sender: "" } });
  const third = await (await r.post(base + "/notifications/sweep", { data: {} })).json();
  expect(third.reminders.queued).toBe(0);
});

test("owner test send lands in the outbox and returns delivery; resend only accepts failed messages; barber cannot manage messaging", async () => {
  const { r } = await onlineShop();
  const sms = await r.post(base + "/notifications/test", { data: { channel: "SMS", to: "07700 900999" } });
  expect(sms.status(), await sms.text()).toBe(201);
  const smsBody = await sms.json();
  expect(smsBody.notification.status).toMatch(/^(SENT|FAILED|QUEUED)$/);
  const email = await r.post(base + "/notifications/test", { data: { channel: "EMAIL", to: "owner-test@example.test" } });
  expect(email.status(), await email.text()).toBe(201);
  const box = await outbox(r);
  const tests = box.notifications.filter((n) => n.template === "test_message");
  expect(tests.length).toBe(2);
  expect(tests.find((n) => n.channel === "EMAIL")?.recipient).toBe("owner-test@example.test");

  // Resend is only for failed messages.
  const sent = tests.find((n) => n.status === "SENT");
  if (sent) {
    const resend = await r.post(base + `/notifications/${sent.id}/resend`, { data: {} });
    expect(resend.status()).toBe(409);
  }
  const missing = await r.post(base + `/notifications/${crypto.randomUUID()}/resend`, { data: {} });
  expect(missing.status()).toBe(409);
  // Bad input.
  expect((await r.post(base + "/notifications/test", { data: { channel: "FAX", to: "x" } })).status()).toBe(400);
  // Switched-off channel refuses a test send.
  await r.put(base + "/shop/messaging", { data: { msg_sms: 0, msg_email: 1, msg_reminders: 1, msg_reminder_hours: 24, msg_reply_to: "", msg_sms_sender: "" } });
  expect((await r.post(base + "/notifications/test", { data: { channel: "SMS", to: "07700 900999" } })).status()).toBe(409);
});

test("customer sign-in code: preview mode shows the code on screen, never claims a text went out", async () => {
  const { slug } = await onlineShop();
  const c = await customer();
  const res = await c.post(`${pub}/shops/${slug}/account/start`, { data: { phone: "07700 900777" } });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  expect(["sms", "on_screen"]).toContain(body.delivery);
  if (body.delivery === "on_screen") expect(body.sandbox_code).toMatch(/^\d{6}$/);
  else expect(body.sandbox_code).toBeUndefined();
});

test("cron route sweeps and drains; rejects a wrong secret when one is configured; health reports messaging", async () => {
  const c = await customer();
  const res = await c.get(origin + "/api/cron/messages");
  // Without CRON_SECRET the route is open (sandbox); with one, an unauthenticated call is 401.
  expect([200, 401]).toContain(res.status());
  if (res.status() === 200) {
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reminders).toHaveProperty("queued");
    expect(body.drained).toBeDefined();
    expect(body.providers.email.provider).toMatch(/^(mailbox|resend)$/);
  }
  const health = await (await c.get(origin + "/api/health")).json();
  expect(health.messaging).toBeDefined();
});

test("browser: Settings → Messages shows provider status, saves channel settings, sends a test, previews an email", async ({ page }) => {
  await enterNewShop(page, "Messages UI shop");
  await section(page, "Settings");
  const status = page.getByTestId("messaging-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText(/Preview mode|Live/);

  // Toggle reminders hours and save.
  const form = page.getByTestId("messaging-form");
  await form.getByTestId("msg-reminder-hours").fill("48");
  await form.getByTestId("save-messaging").click();
  await expect(form.getByTestId("msg-reminder-hours")).toHaveValue("48");
  const saved = await (await page.request.get(base + "/notifications")).json();
  expect(saved.messaging.msg_reminder_hours).toBe(48);

  // Send a test email; it appears in the outbox with a preview.
  const testForm = page.getByTestId("test-message-form");
  await testForm.getByTestId("test-channel").selectOption("EMAIL");
  await testForm.getByTestId("test-to").fill("owner-ui@example.test");
  await testForm.getByTestId("send-test").click();
  await expect(page.getByTestId("test-result")).toContainText(/sent|queued|preview|mailbox/i);
  const row = page.locator("[data-status]").filter({ hasText: "owner-ui@example.test" }).first();
  await expect(row).toBeVisible();
  await row.getByTestId("preview-email").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("iframe.email-preview, .email-preview iframe, iframe")).toHaveCount(1);
  await dialog.getByRole("button", { name: /close/i }).first().click();
  await expect(dialog).toBeHidden();

  // Filter: Sent shows the row; Failed hides it.
  await page.locator(".outbox-head").getByRole("button", { name: "Failed" }).click();
  await expect(page.locator("[data-status]").filter({ hasText: "owner-ui@example.test" })).toHaveCount(0);
  await page.locator(".outbox-head").getByRole("button", { name: "All" }).click();
  await expect(page.locator("[data-status]").filter({ hasText: "owner-ui@example.test" }).first()).toBeVisible();
});
