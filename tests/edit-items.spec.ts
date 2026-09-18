import { test, expect, type Page } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";

// Phase 2: edit service / add-ons / price / duration on a live appointment. Re-pricing below a paid
// deposit refunds the difference and charges it to the barber's next pay run.

type W = { today: string; shop: { id: string }; staff: { id: string; name: string }[]; services: { id: string; name: string; price_pence: number; duration_min: number }[]; addons: { id: string; name: string; price_pence: number; duration_min: number; active: number }[]; addon_links: { addon_id: string; service_id: string }[] };

async function book(page: Page, w: W, staffId: string, serviceId: string, name: string) {
  for (let i = 1; i < 12; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const avail = await (await page.request.get(base + `/availability?date=${date}&staff_id=${staffId}&service_id=${serviceId}`)).json();
    const free = avail.slots.filter((s: { reason?: string }) => !s.reason);
    if (free.length < 4) continue;
    const r = await page.request.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: staffId, service_id: serviceId, customer_name: name, phone: "07700 900777", notes: "", date, start_min: free[1].start_min, source: "TEST_BOOKING", quote: avail.quote } });
    expect(r.status(), await r.text()).toBe(201);
    return { booking: (await r.json()).booking, date, free };
  }
  throw new Error("no slot");
}
const patch = (page: Page, id: string, body: unknown) => page.request.patch(base + `/bookings/${id}/items`, { headers: { Origin: origin }, data: body });

test("API: edit price, duration, service and add-ons; audit; refuses paid/closed; deposit refund charges the barber's pay run", async ({ page }) => {
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const svc = w.services[0];
  const { booking, date } = await book(page, w, jay.id, svc.id, "Edit Client");

  // 1. Price down + 10 more minutes.
  let r = await patch(page, booking.id, { service_id: svc.id, addon_ids: [], service_price_pence: booking.price_pence - 500, service_duration_min: booking.duration_min + 10, addon_prices: {}, reason: "Loyal customer discount", version: booking.version });
  expect(r.status(), await r.text()).toBe(200);
  let j = await r.json();
  expect(j.booking.price_pence).toBe(booking.price_pence - 500);
  expect(j.booking.duration_min).toBe(booking.duration_min + 10);
  expect(j.booking.items_edited_at).toBeTruthy();
  expect(j.refunded_pence).toBe(0);
  expect(JSON.parse(j.booking.items_json)[0].price_pence).toBe(booking.price_pence - 500);

  // 2. Stale version refused.
  r = await patch(page, booking.id, { service_id: svc.id, addon_ids: [], addon_prices: {}, reason: "stale", version: booking.version });
  expect(r.status()).toBe(409);

  // 3. Switch service and add an add-on linked to it.
  const other = w.services.find((s) => s.id !== svc.id && w.addon_links.some((l) => l.service_id === s.id)) || w.services.find((s) => s.id !== svc.id)!;
  const addon = w.addons.find((a) => a.active && w.addon_links.some((l) => l.addon_id === a.id && l.service_id === other.id));
  r = await patch(page, booking.id, { service_id: other.id, addon_ids: addon ? [addon.id] : [], addon_prices: {}, reason: "Went for something else", version: j.booking.version });
  expect(r.status(), await r.text()).toBe(200);
  j = await r.json();
  expect(j.booking.service_id).toBe(other.id);
  expect(j.booking.service_name).toBe(other.name);
  const items = JSON.parse(j.booking.items_json);
  expect(items.length).toBe(addon ? 2 : 1);
  expect(j.booking.items_edited_at).toBeNull(); // back to catalogue prices → not "edited"

  // 4. Timeline carries ITEMS_UPDATED with the before → after summary.
  const tl = await (await page.request.get(base + `/bookings/${booking.id}/timeline`)).json();
  expect(JSON.stringify(tl)).toContain("ITEMS_UPDATED");
  expect(JSON.stringify(tl)).toContain("Loyal customer discount");

  // 5. Deposit refund path: mark a deposit as paid directly (preview mode has no Stripe), then
  //    re-price below it. The difference is recorded as a negative adjustment for Jay's pay run.
  const cur = j.booking;
  const depositPence = 2000;
  const pg = await import("node:child_process");
  const url = (await import("node:fs")).readFileSync("/home/user/webapp/.env.local", "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
  pg.execSync(`psql "${url}" -Atc "UPDATE bookings SET deposit_status='PAID', deposit_paid_pence=${depositPence} WHERE id='${cur.id}'"`);
  r = await patch(page, cur.id, { service_id: cur.service_id, addon_ids: [], service_price_pence: 1500, addon_prices: {}, reason: "Only did the basic cut", version: cur.version });
  expect(r.status(), await r.text()).toBe(200);
  j = await r.json();
  expect(j.refunded_pence).toBe(500);
  expect(j.booking.deposit_paid_pence).toBe(1500);
  const adj = await (await page.request.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${date}&to=${date}`)).json();
  expect(adj.auto_adjustments.length).toBe(1);
  expect(adj.auto_adjustments[0].pence).toBe(-500);
  expect(adj.result.adjustments_pence).toBe(-500);
  // Creating the run claims the adjustment; a second preview shows none open.
  const run = await page.request.post(base + "/pay-runs", { headers: { Origin: origin }, data: { staff_id: jay.id, period_from: date, period_to: date, adjustments: [], note: "" } });
  expect(run.status(), await run.text()).toBe(201);
  const runJson = await run.json();
  expect(JSON.parse(runJson.pay_run.adjustments_json)[0].pence).toBe(-500);
  const again = await (await page.request.get(base + `/pay-runs/preview?staff_id=${jay.id}&from=${date}&to=${date}`)).json();
  expect(again.auto_adjustments.length).toBe(0);

  // 6. Once the visit is closed the items are frozen.
  const co = await page.request.post(base + `/bookings/${j.booking.id}/status`, { headers: { Origin: origin }, data: { status: "COMPLETED", reason: "done", version: j.booking.version } });
  expect(co.status(), await co.text()).toBe(200);
  const fresh = (await (await page.request.get(base + `/bookings/${j.booking.id}`)).json()).booking;
  r = await patch(page, fresh.id, { service_id: fresh.service_id, addon_ids: [], addon_prices: {}, reason: "too late", version: fresh.version });
  expect(r.status()).toBe(409);
});

test("browser: change price and time from the appointment panel; calendar card and total follow", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const { booking, date } = await book(page, w, jay.id, w.services[0].id, "Panel Edit");
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await page.getByRole("button", { name: /Panel Edit/ }).click();
  await page.getByTestId("edit-items").click();
  await expect(page.getByTestId("items-editor")).toBeVisible();
  await page.getByTestId("items-price").fill("22.50");
  await page.getByRole("button", { name: "5 minutes more" }).click();
  await expect(page.getByTestId("items-total")).toContainText("£22.50");
  await expect(page.getByTestId("items-total")).toContainText(`${booking.duration_min + 5} min`);
  await page.getByTestId("items-reason").fill("Mate's rates");
  await page.getByTestId("items-save").click();
  await expect(page.locator(".panel-total")).toContainText("£22.50");
  await expect(page.locator(".panel-total")).toContainText("edited");
  await expect(page.getByRole("button", { name: /Checkout · £22\.50/ })).toBeVisible();
  const fresh = (await (await page.request.get(base + `/bookings/${booking.id}`)).json()).booking;
  expect(fresh.price_pence).toBe(2250);
  expect(fresh.duration_min).toBe(booking.duration_min + 5);
});
