import { expect, test, type APIRequestContext } from "@playwright/test";
import { base, newShop, origin } from "./shop";

// Insights figures against hand-worked numbers, with history built only through the real API:
// the shop side may book past times, status changes and checkout write the real records/ledger.
const headers = { Origin: origin };
function plus(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// A past (or future) working day: the fixture shop is closed on Sundays.
function workday(today: string, offset: number) {
  let d = plus(today, offset);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() === 0) d = plus(d, offset < 0 ? -1 : 1);
  return d;
}
async function book(r: APIRequestContext, w: any, staff: string, service: string, date: string, start_min: number, phone: string) {
  const s = w.services.find((x: any) => x.name === service);
  const res = await r.post(base + "/bookings", {
    headers,
    data: {
      request_id: crypto.randomUUID(), staff_id: staff, service_id: s.id, date, start_min,
      customer_name: `Insight ${phone.slice(-3)}`, phone, source: "TEST_BOOKING", notify: false,
      quote: { service_version: s.version, shop_version: w.shop.version },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).booking;
}
async function status(r: APIRequestContext, b: any, to: string) {
  const res = await r.post(base + `/bookings/${b.id}/status`, { headers, data: { status: to, reason: "Insights test", version: b.version, notify: false } });
  expect(res.ok(), await res.text()).toBe(true);
}
async function checkout(r: APIRequestContext, b: any, service_pence: number, tip_pence = 0) {
  const res = await r.post(base + `/bookings/${b.id}/checkout`, { headers, data: { version: b.version, tenders: [{ method: "CASH", service_pence, tip_pence }], complete: true } });
  expect(res.ok(), await res.text()).toBe(true);
}

test("insights figures match hand-worked numbers built through the real API", async () => {
  const { r } = await newShop("Insights maths shop");
  const w = await (await r.get(base + "/workspace")).json();
  const jay = w.staff.find((s: any) => s.name === "Jay Carter").id;
  const marcus = w.staff.find((s: any) => s.name === "Marcus Reed").id;
  const d1 = workday(w.today, -3), d2 = workday(w.today, -6), old = workday(w.today, -40);
  const A = "07700900401", B = "07700900402", C = "07700900403";
  await book(r, w, jay, "Signature cut", old, 540, A); // history before the period: A is returning
  const b1 = await book(r, w, jay, "Signature cut", d1, 540, A); // completed, £28 + £2 tip
  const b2 = await book(r, w, jay, "Skin fade", d1, 600, B); // online-style no-show
  const b3 = await book(r, w, marcus, "Cut & beard", d2, 600, C); // completed, £42
  const b4 = await book(r, w, marcus, "Signature cut", d2, 840, A); // cancelled
  await book(r, w, marcus, "Signature cut", workday(w.today, 3), 600, B); // upcoming
  await checkout(r, b1, 2800, 200);
  await status(r, b2, "NO_SHOW");
  await checkout(r, b3, 4200);
  await status(r, b4, "CANCELLED");

  const j = await (await r.get(base + "/insights?days=30")).json();
  const n = (f: (x: any) => boolean) => j.by_status.filter(f).reduce((t: number, x: any) => t + x.n, 0);
  expect(n(() => true)).toBe(4);
  expect(n((x) => x.status === "CANCELLED")).toBe(1);
  expect(n((x) => x.status === "NO_SHOW")).toBe(1);
  expect(n((x) => x.status === "COMPLETED")).toBe(2);
  // Taken comes from the payments ledger (what the wallet shows), tips included.
  expect(j.taken).toEqual({ service: 7000, tips: 200 });
  // Seen = actually came in (no-show and cancelled excluded); A came before the period, C is new.
  expect(j.customers).toEqual({ customers: 2, new_customers: 1 });
  expect(j.upcoming.n).toBe(1);
  const row = (id: string) => j.barbers.find((b: any) => b.staff_id === id);
  expect(row(jay)).toMatchObject({ n: 1, minutes: 30, no_shows: 1, taken: 3000 });
  expect(row(marcus)).toMatchObject({ n: 1, minutes: 60, no_shows: 0, taken: 4200 });
  await r.dispose();
});
