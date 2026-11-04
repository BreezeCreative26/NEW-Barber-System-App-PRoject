// Shop-made bookings: out-of-hours times are selectable in the form (flagged as an override),
// and one phone / one email can only ever belong to one customer in a shop.
import { test, expect } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";
import { newShop } from "./shop";

type W = { today: string; staff: { id: string; name: string; active: number }[]; services: { id: string; name: string }[] };

async function slotsFor(page: import("@playwright/test").Page, w: W) {
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const svc = w.services[0];
  for (let i = 1; i < 14; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const a = await (await page.request.get(base + `/availability?date=${date}&staff_id=${jay.id}&service_id=${svc.id}`)).json();
    if (a.slots.some((s: { reason?: string; outside?: boolean }) => !s.reason && s.outside) && a.slots.some((s: { reason?: string; outside?: boolean }) => !s.reason && !s.outside))
      return { date, jay, svc };
  }
  throw new Error("no suitable day");
}

test("UI: outside-hours times are ordinary bookable times for staff, listed apart, with no override warning", async ({ page }) => {
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const { date, svc } = await slotsFor(page, w);
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await page.getByLabel("Service", { exact: true }).selectOption({ label: svc.name });
  const select = page.getByLabel("Available start time");
  await expect(select.locator('option[value="420"]')).toHaveCount(1);
  // One plain list: no reason labels, nothing greyed out, no groups for out-of-hours.
  const labels = await select.locator("option").allTextContents();
  expect(labels.slice(1).every((t) => /^\d\d:\d\d$/.test(t.trim()))).toBe(true);
  expect(await select.locator("option:disabled").count()).toBe(0);
  // The list starts at opening time; early times sit in one plain "Earlier" group (no reason labels).
  expect(await select.locator("optgroup").evaluateAll((gs) => gs.map((g) => g.getAttribute("label")))).toEqual(["Earlier"]);
  // An early (out-of-hours) time is in the list and books like any other, with no warning.
  await select.selectOption("420");
  await expect(page.getByTestId("override-notice")).toHaveCount(0);
});

test("API: staff book outside hours with no force flag; customers online still can't", async ({ page }) => {
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const { date, jay, svc } = await slotsFor(page, w);
  const a = await (await page.request.get(base + `/availability?date=${date}&staff_id=${jay.id}&service_id=${svc.id}`)).json();
  const out = a.slots.find((s: { reason: string; outside: boolean }) => !s.reason && s.outside);
  expect(out, "an outside-hours slot is offered to staff").toBeTruthy();
  const r = await page.request.post(base + "/bookings", {
    headers: { Origin: origin },
    data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: svc.id, customer_name: "Early Bird", phone: "07700 900777", notes: "", date, start_min: out.start_min, source: "TEST_BOOKING", quote: a.quote, notify: false },
  });
  expect(r.status(), await r.text()).toBe(201);
  // Not flagged as a schedule problem on the bell.
  const after = await (await page.request.get(base + "/workspace")).json();
  const bid = (await r.json()).booking.id;
  expect(after.issues.some((i: { booking_id: string }) => i.booking_id === bid)).toBe(false);
});

test("API: a customer's phone or email can't be used by a second customer (create, edit, booking)", async () => {
  const { r } = await newShop("Dupes Cuts");
  const mk = (name: string, phone: string, email: string) => r.post(base + "/customers", { data: { name, phone, email } });
  const a = await mk("Ann One", "07700 900301", "ann@example.test");
  expect(a.status(), await a.text()).toBe(201);
  // Same phone refused.
  expect((await mk("Ann Again", "07700 900301", "other@example.test")).status()).toBe(409);
  // Same email refused, whatever the case.
  const dupEmail = await mk("Bob Two", "07700 900302", "ANN@example.test");
  expect(dupEmail.status()).toBe(409);
  expect(await dupEmail.text()).toContain("email");
  // A different person is fine; then editing them onto Ann's email is refused.
  const b = await mk("Bob Two", "07700 900302", "bob@example.test");
  expect(b.status(), await b.text()).toBe(201);
  const bob = (await b.json()).customer;
  const edit = await r.put(base + `/customers/${bob.id}`, { data: { name: "Bob Two", phone: "07700 900302", email: "ann@example.test", version: bob.version } });
  expect(edit.status()).toBe(409);
  // Keeping his own email on an edit still works.
  const keep = await r.put(base + `/customers/${bob.id}`, { data: { name: "Bob Two B", phone: "07700 900302", email: "bob@example.test", version: bob.version } });
  expect(keep.status(), await keep.text()).toBe(200);
  // A manual booking for a NEW phone but Ann's email is refused rather than making a second record.
  const w = await (await r.get(base + "/workspace")).json();
  const staff = w.staff.find((s: { active: number }) => s.active);
  const svc = w.services[0];
  let date = "";
  let quote: unknown;
  let start = 0;
  for (let i = 1; i < 14 && !date; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    const av = await (await r.get(base + `/availability?date=${day}&staff_id=${staff.id}&service_id=${svc.id}`)).json();
    const free = av.slots.find((s: { reason?: string }) => !s.reason);
    if (free) { date = day; quote = av.quote; start = free.start_min; }
  }
  const book = (phone: string, email: string) =>
    r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "New Person", phone, email, notes: "", date, start_min: start, source: "TEST_BOOKING", quote, notify: false } });
  const clash = await book("07700 900399", "ann@example.test");
  expect(clash.status(), await clash.text()).toBe(409);
  const ok = await book("07700 900399", "new.person@example.test");
  expect(ok.status(), await ok.text()).toBe(201);
});
