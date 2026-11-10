// The "needs schedule review" banner on the calendar can be dismissed there (per login), leaving the
// appointment itself booked as it is.
import { test, expect } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";

test("calendar banner: Dismiss hides a schedule issue for this login and keeps the appointment", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page);
  const r = page.request;
  const w = await (await r.get(base + "/workspace")).json();
  const svc = w.services.find((s: any) => s.duration_min === 30) ?? w.services[0];
  const staff = w.staff.find((s: any) => s.active);
  let date = "", free: any = null;
  for (let i = 10; i < 24 && !free; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${staff.id}&service_id=${svc.id}`)).json();
    free = (a.slots || []).find((s: any) => !s.reason && !s.outside && !s.taken);
  }
  expect(free, "no free slot").toBeTruthy();
  const made = await r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Banner Issue Client", phone: "07700900457", date, start_min: free.start_min, source: "TEST_BOOKING", quote: { service_version: svc.version, shop_version: w.shop.version } } });
  expect(made.status(), await made.text()).toBe(201);
  const booked = (await made.json()).booking;
  const off = await r.post(base + `/staff/${staff.id}/days-off`, { headers: { Origin: origin }, data: { date, reason: "Fictional leave" } });
  expect(off.status(), await off.text()).toBe(201);
  const issue = (await (await r.get(base + "/workspace")).json()).issues.find((i: any) => i.booking_id === booked.id);
  expect(issue).toBeTruthy();

  await page.reload();
  const row = page.getByTestId("banner-issue").filter({ hasText: issue.ref });
  await expect(row).toContainText(issue.reason);
  await row.getByTestId("banner-dismiss").click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "New booking", exact: true }).waitFor();
  await expect(page.getByTestId("banner-issue").filter({ hasText: issue.ref })).toHaveCount(0);
  const inbox = await (await r.get(base + "/inbox")).json();
  expect(inbox.dismissed).toContain(`${issue.booking_id}|${issue.reason}`);
  // The appointment is untouched.
  const still = (await (await r.get(base + `/bookings/${booked.id}`)).json()).booking;
  expect(still.status).toBe("CONFIRMED");
  expect(still.date).toBe(date);
});
