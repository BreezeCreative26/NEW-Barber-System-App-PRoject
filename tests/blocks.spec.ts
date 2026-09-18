import { test, expect, type Page } from "@playwright/test";
import { openFixtureShop, base, origin } from "./fixture";

// Phase 3 of the Fresha-grade calendar: blocked time with a reason, per-customer resolutions
// (keep / move / cancel + refund) with notifications, the scheduled-team picker and the ⋯ menu.

type W = { today: string; staff: { id: string; name: string; active: number }[]; services: { id: string; name: string }[]; blocks: { id: string }[] };

async function freeDay(page: Page, w: W, staffId: string, serviceId: string) {
  for (let i = 1; i < 12; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const avail = await (await page.request.get(base + `/availability?date=${date}&staff_id=${staffId}&service_id=${serviceId}`)).json();
    const free = avail.slots.filter((s: { reason?: string }) => !s.reason);
    if (free.length >= 8) return { date, free: free as { start_min: number }[], quote: avail.quote };
  }
  throw new Error("no free day");
}

test("API: block time → preview lists affected visits with channel → move/cancel/keep applied, customers notified, block visible and overridable", async ({ page }) => {
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const svc = w.services[0];
  const { date, free, quote } = await freeDay(page, w, jay.id, svc.id);
  const t0 = free[1].start_min;
  const mk = async (name: string, start: number) =>
    (await (await page.request.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: svc.id, customer_name: name, phone: "07700 900111", notes: "", date, start_min: start, source: "TEST_BOOKING", quote } })).json()).booking;
  const a = await mk("Move Me", t0);
  const b = await mk("Cancel Me", t0 + 60);
  const c = await mk("Keep Me", t0 + 120);
  // Preview
  const pv = await page.request.post(base + `/staff/${jay.id}/blocks/preview`, { headers: { Origin: origin }, data: { date, start_min: t0, end_min: t0 + 150 } });
  expect(pv.status(), await pv.text()).toBe(200);
  const preview = await pv.json();
  expect(preview.affected.map((x: { id: string }) => x.id).sort()).toEqual([a.id, b.id, c.id].sort());
  expect(preview.affected[0].channel).toBe("SMS");
  expect(preview.suggestions[a.id]).toBeTruthy();
  // Undecided → 409
  const undecided = await page.request.post(base + `/staff/${jay.id}/blocks`, { headers: { Origin: origin }, data: { date, start_min: t0, end_min: t0 + 150, kind: "TRAINING", reason: "Barbering course" } });
  expect(undecided.status()).toBe(409);
  const s = preview.suggestions[a.id];
  const created = await page.request.post(base + `/staff/${jay.id}/blocks`, {
    headers: { Origin: origin },
    data: {
      date, start_min: t0, end_min: t0 + 150, kind: "TRAINING", reason: "Barbering course",
      resolutions: [
        { booking_id: a.id, action: "MOVE", notify: true, move_to: { staff_id: s.staff_id, date: s.date, start_min: s.start_min } },
        { booking_id: b.id, action: "CANCEL", notify: true },
        { booking_id: c.id, action: "KEEP", notify: false },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const out = await created.json();
  expect(out.block.reason).toBe("Barbering course");
  expect(out.outcome.every((o: { ok: boolean }) => o.ok), JSON.stringify(out.outcome)).toBe(true);
  const moved = (await (await page.request.get(base + `/bookings/${a.id}`)).json()).booking;
  expect(moved.start_min).toBe(s.start_min);
  expect(moved.date).toBe(s.date);
  expect((await (await page.request.get(base + `/bookings/${b.id}`)).json()).booking.status).toBe("CANCELLED");
  expect((await (await page.request.get(base + `/bookings/${c.id}`)).json()).booking.status).toBe("CONFIRMED");
  expect(out.outcome.find((o: { booking_id: string }) => o.booking_id === b.id).notified).toContain("SMS");
  // Block shows in the workspace, greys availability (soft), public availability hides the reason.
  const w2 = (await (await page.request.get(base + "/workspace")).json()) as W;
  expect(w2.blocks.some((k) => k.id === out.block.id)).toBe(true);
  const avail = await (await page.request.get(base + `/availability?date=${date}&staff_id=${jay.id}&service_id=${svc.id}`)).json();
  expect(avail.slots.find((x: { start_min: number }) => x.start_min === t0 + 30).reason).toBe("Blocked time");
  const slug = (await (await page.request.get(base + "/workspace")).json()).shop.slug;
  const pub = await (await page.request.get(origin + `/api/public/shops/${slug}/availability?date=${date}&service_id=${svc.id}&staff_id=${jay.id}`)).json();
  const pubSlot = pub.slots?.find((x: { start_min: number }) => x.start_min === t0 + 30);
  if (pubSlot) expect(pubSlot.reason).not.toContain("Blocked");
  // Shop can still book over the block with force; then remove the block.
  const over = await page.request.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: jay.id, service_id: svc.id, customer_name: "Over Block", phone: "07700 900222", notes: "", date, start_min: t0 + 30, source: "TEST_BOOKING", quote, force: true } });
  expect(over.status(), await over.text()).toBe(201);
  const del = await page.request.delete(base + `/staff/${jay.id}/blocks/${out.block.id}`, { headers: { Origin: origin } });
  expect(del.status()).toBe(200);
});

test("browser: ⋯ menu blocks time with a reason; the grey card appears; scheduled team picker adds a non-rostered barber", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page);
  const w = (await (await page.request.get(base + "/workspace")).json()) as W;
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const { date } = await freeDay(page, w, jay.id, w.services[0].id);
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await page.getByTestId("staff-menu").first().click();
  await page.getByRole("menuitem", { name: /Block time/ }).click();
  const dialog = page.getByTestId("block-dialog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("block-from").fill("14:00");
  await page.getByTestId("block-until").fill("15:00");
  await page.getByTestId("block-reason").fill("Dentist");
  await page.getByTestId("block-check").click();
  await expect(page.getByTestId("block-outcome")).toBeVisible();
  await expect(page.getByTestId("block-outcome")).toContainText("Dentist");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const card = page.getByTestId("calendar-block").filter({ hasText: "Dentist" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("14:00–15:00");
  // Scheduled team: pick a Monday (Dani doesn't work Mondays in the fixture) and add her.
  const d = new Date(w.today + "T12:00:00Z");
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== 1);
  await page.getByLabel("Appointment date", { exact: true }).fill(d.toISOString().slice(0, 10));
  const picker = page.getByTestId("team-picker");
  await expect(picker).toContainText("2/3");
  await picker.click();
  await page.getByRole("dialog", { name: "Scheduled team" }).getByLabel(/Dani Okoro/).check();
  await expect(picker).toContainText("3/3");
  await expect(page.locator(".staff-column-heading")).toHaveCount(3);
});
