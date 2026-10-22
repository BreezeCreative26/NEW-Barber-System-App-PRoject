// Messages: the outbox is a real delivery queue. Without provider keys the sandbox uses the
// "mailbox" provider (status SENT, nothing leaves), so these tests assert the queue contract:
// what gets enqueued, in which channels, branded for the shop, idempotent reminders, owner
// settings, test send, resend and the cron route. Every test creates its own fictional shop.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin, newShop, enterNewShop, registerCustomer } from "./shop";
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
  await registerCustomer(c, slug, { name: String(data.customer_name), phone: String(data.phone), email: String(data.email) });
  const res = await c.post(`${pub}/shops/${slug}/bookings`, { data });
  expect(res.status(), await res.text()).toBe(201);
  return res.json() as Promise<{ booking: { id: string; version: number }; manage_token: string; sent_to: string[] }>;
}

test("booking created → confirmation queued on SMS and email, shop-branded, never foliyo; cancel via manage link notifies", async () => {
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
    expect(n.body).toMatch(/\/(manage\/|me\?visit=)/); // account holders land in their account, guests get the one-time link
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
  expect(box.providers.sms.provider).toMatch(/^(mailbox|twilio|clicksend)$/);

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
    const res = await r.put(base + "/shop/messaging", { data: { sms_billing_ack: true, msg_sms, msg_email, msg_reminders: 1, msg_reminder_hours: 24, msg_reply_to: "", msg_sms_sender: "" } });
    expect(res.status(), await res.text()).toBe(200);
  };
  await set(0, 1);
  const a = await bookOnline(c, slug, w, futureDate(9), 600);
  expect(a.sent_to).toEqual(["EMAIL"]);
  let box = await outbox(r);
  expect(box.messaging.msg_sms).toBe(0);
  // Owner alerts share the booking's related_id; this test is about the customer's channels.
  const customerRows = (rows: typeof box.notifications, id: string) => rows.filter((n) => n.related_id === id && !n.template.startsWith("owner_"));
  expect(customerRows(box.notifications, a.booking.id).map((n) => n.channel)).toEqual(["EMAIL"]);

  await set(0, 0);
  const b = await bookOnline(c, slug, w, futureDate(10), 600);
  expect(b.sent_to).toEqual([]);
  box = await outbox(r);
  expect(customerRows(box.notifications, b.booking.id)).toEqual([]);

  // Validation: reply-to must be an email, sender max 11 alphanumerics.
  const bad = await r.put(base + "/shop/messaging", { data: { sms_billing_ack: true, msg_sms: 1, msg_email: 1, msg_reminders: 1, msg_reminder_hours: 24, msg_reply_to: "not-an-email", msg_sms_sender: "Way Too Long Sender!" } });
  expect(bad.status()).toBe(400);
});

test("reminders sweep is idempotent: one reminder per booking per window, honours the shop's reminder hours", async () => {
  const { r, w, slug } = await onlineShop();
  const c = await customer();
  // 24h reminder window is (h-1, h] hours ahead. Book something 23.5h from now on a 15-minute grid.
  const target = new Date(Date.now() + 23.5 * 3600000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(target);
  if (new Date(date + "T00:00:00Z").getUTCDay() === 0) test.skip(true, "target day is Sunday (shop closed)");
  // Pick the first available slot on that day nearest the target — availability tells us what's open.
  const staff = w.staff[0].id, service = w.services[0].id;
  const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const slots: number[] = (avail.slots as { start_min: number; available: boolean }[]).filter((s) => s.available).map((s) => s.start_min);
  test.skip(slots.length === 0, "no open slot on the target day");
  // Shop-local minutes (Europe/London), not UTC: they differ by an hour while British Summer Time runs.
  const londonMin = (t: Date) => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t); return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value); };
  const wantMin = londonMin(target);
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
  const noonLondon = new Date(`${date}T12:00:00Z`);
  const offsetMin = londonMin(noonLondon) - 12 * 60; // 0 in winter, 60 in summer time
  const startsAt = new Date(`${date}T00:00:00Z`).getTime() + (start_min - offsetMin) * 60000;
  const hoursAhead = (startsAt - Date.now()) / 3600000;
  if (first.reminders.queued > 0 && hoursAhead > 23 && hoursAhead <= 24) {
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    expect(reminders[0].body).toMatch(/tomorrow|reminder|see you/i);
    expect(reminders[0].body).toMatch(new RegExp(`${slug}[^ ]*/me`)); // the shop's own address, then /me
  }
  // Reminders off → sweep queues nothing for this shop.
  await r.put(base + "/shop/messaging", { data: { sms_billing_ack: true, msg_sms: 1, msg_email: 1, msg_reminders: 0, msg_reminder_hours: 24, msg_reply_to: "", msg_sms_sender: "" } });
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
  await r.put(base + "/shop/messaging", { data: { sms_billing_ack: true, msg_sms: 0, msg_email: 1, msg_reminders: 1, msg_reminder_hours: 24, msg_reply_to: "", msg_sms_sender: "" } });
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
  await section(page, "Settings/messages");
  const status = page.getByTestId("messaging-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText(/Preview mode|Live/);

  // Toggle reminders hours and save.
  const form = page.getByTestId("messaging-form");
  await form.getByTestId("msg-reminder-hours").fill("48");
  // First save with texts on: accept the per-text price.
  const ack = form.getByTestId("msg-sms-billing-ack");
  if (await ack.count()) await ack.locator("input").check();
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
  await page.getByTestId("open-history").click();
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

test("a moved booking gets a fresh reminder: the old reminder is retired, an unsent one is cancelled", async () => {
  const { r, w, slug } = await onlineShop();
  const c = await customer();
  const staff = w.staff[0].id, service = w.services[0].id;
  let date = "", slots: number[] = [];
  for (let d = 3; d < 12 && !slots.length; d++) {
    date = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
    slots = (avail.slots as { start_min: number; available: boolean; reason?: string }[]).filter((s) => s.available !== false && !s.reason).map((s) => s.start_min);
  }
  expect(slots.length).toBeGreaterThan(0);
  const created = await bookOnline(c, slug, w, date, slots[0]);
  const id = created.booking.id as string;
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL || process.env.DIRECT_URL || "postgresql://postgres:postgres@127.0.0.1:5432/ollo", { max: 1 });
  try {
    const shopId = (w as unknown as { shop: { id: string } }).shop.id;
    const ins = (nid: string, status: string) => sql`INSERT INTO notifications(id,shop_id,channel,recipient,template,body,status,related_type,related_id,created_at)
      VALUES (${nid}, ${shopId}, 'SMS', '07700900000', 'booking_reminder', 'x', ${status}, 'booking', ${id}, ${Date.now()})`;
    const marks = async () => Number((await sql`SELECT count(*)::int AS n FROM reminder_marks WHERE booking_id=${id}`)[0].n);
    const b0 = (await sql`SELECT start_at FROM bookings WHERE id=${id}`)[0].start_at;
    // Put the booking inside the 24h window, sweep: one reminder. Sweep again: none (de-duplicated).
    const hrs = 23.5 * 3600000, shift = Number(Date.now() + hrs) - Number(b0);
    await sql`UPDATE bookings SET start_at = start_at + ${shift}, end_at = end_at + ${shift}, version = version + 1 WHERE id=${id}`;
    const a = await (await r.post(base + "/notifications/sweep", { data: {} })).json();
    expect(await marks()).toBe(1);
    const again = await (await r.post(base + "/notifications/sweep", { data: {} })).json();
    expect(await marks()).toBe(1);
    expect(a.reminders.queued).toBeGreaterThan(0);
    expect(again.reminders.queued).toBe(0);
    // A reminder still waiting to send is cancelled when the booking moves.
    await ins("rem-wait-" + id, "QUEUED");
    const s2 = 6 * 3600000;
    await sql`UPDATE bookings SET start_at = start_at + ${s2}, end_at = end_at + ${s2}, version = version + 1 WHERE id=${id}`;
    expect((await sql`SELECT status FROM notifications WHERE id=${"rem-wait-" + id}`)[0].status).toBe("SKIPPED");
    // Move it back into the window at a new time: it is reminded again.
    const s3 = -(s2 - 600000);
    await sql`UPDATE bookings SET start_at = start_at + ${s3}, end_at = end_at + ${s3}, version = version + 1 WHERE id=${id}`;
    await r.post(base + "/notifications/sweep", { data: {} });
    expect(await marks()).toBe(2);
  } finally { await sql.end(); }
});

test("team bell: owner sees everything, a barber only their own bookings until granted all notifications", async () => {
  const { r, w, slug } = await onlineShop("Bell Test Shop");
  const joinAs = async (staffIndex: number) => {
    const address = `bell-${crypto.randomUUID().slice(0, 8)}@ollo.test`;
    const inv = await r.post(base + "/auth/invites", { data: { email: address, role: "BARBER", staff_id: w.staff[staffIndex].id } });
    expect(inv.status(), await inv.text()).toBe(201);
    const ctx = await customer();
    const acc = await ctx.post(base + "/auth/accept", { data: { accept_legal: true, token: (await inv.json()).token, name: "Bell Barber", email: address, password: "Unique fictional test password 438!" } });
    expect(acc.status(), await acc.text()).toBe(201);
    return ctx;
  };
  const mine = await joinAs(0);
  const other = await joinAs(1);
  const c = await customer();
  const created = await bookOnline(c, slug, w, futureDate(9)); // booked with staff[0]
  await c.post(`${pub}/manage/${created.manage_token}/cancel`, { data: { version: created.booking.version } });

  const titles = async (ctx: APIRequestContext) => ((await (await ctx.get(base + "/inbox")).json()).events as { title: string }[]).map((e) => e.title);
  const ownerFeed = await (await r.get(base + "/inbox")).json();
  expect(ownerFeed.all).toBe(true);
  expect(ownerFeed.unread).toBeGreaterThanOrEqual(2);
  expect(await titles(r)).toEqual(expect.arrayContaining(["New booking", "Booking cancelled"]));
  expect(await titles(mine)).toEqual(expect.arrayContaining(["New booking", "Booking cancelled"]));
  expect(await titles(other)).toEqual([]);

  // Granting "all notifications" opens the whole feed to that barber.
  const access = await (await r.get(base + "/auth/access")).json();
  const otherEmail = (await (await other.get(base + "/auth/me")).json()).account?.email;
  const member = access.members.find((m: { email: string }) => m.email === otherEmail);
  const grant = await r.put(base + `/auth/members/${member.id}/permissions`, { data: { calendar: false, insights: false, pay: false, setup: false, all_notifications: true } });
  expect(grant.status(), await grant.text()).toBe(200);
  expect(await titles(other)).toEqual(expect.arrayContaining(["New booking"]));

  // Opening the bell marks everything seen for that person only.
  await r.post(base + "/inbox/read", { data: {} });
  expect((await (await r.get(base + "/inbox")).json()).unread).toBe(0);
  expect((await (await mine.get(base + "/inbox")).json()).unread).toBeGreaterThanOrEqual(2);
});

test("customer repeat booking: every 2 weeks books each free date and lists the rest", async () => {
  const { w, slug } = await onlineShop("Repeat Test Shop");
  const c = await customer();
  const created = await bookOnline(c, slug, w, futureDate(9), 600, { repeat_weeks: 2, repeat_visits: 3 });
  const rep = (created as unknown as { repeats: { booked: string[]; skipped: unknown[] } }).repeats;
  expect(rep.booked.length + rep.skipped.length).toBe(3);
  expect(rep.booked.length).toBeGreaterThanOrEqual(1);
});
