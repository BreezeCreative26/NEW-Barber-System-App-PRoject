// One customer, one set of details: editing a customer's name / mobile / email — from their customer
// record or from one of their appointments — updates the record, every appointment on the calendar,
// waiting-list entries and standing series together. Fictional shop through the real API.
import { test, expect } from "@playwright/test";
import { base, newShop } from "./shop";

type W = { today: string; staff: { id: string; active: number }[]; services: { id: string }[] };

async function world(name: string) {
  const { r } = await newShop(name);
  const w = (await (await r.get(base + "/workspace")).json()) as W;
  const staff = w.staff.find((s) => s.active)!;
  const svc = w.services[0];
  // Two future visits for the same person (same mobile → one customer record).
  const visits: { id: string; customer_id: string; version: number }[] = [];
  for (let i = 1; visits.length < 2 && i < 21; i++) {
    const d = new Date(w.today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const a = await (await r.get(base + `/availability?date=${date}&staff_id=${staff.id}&service_id=${svc.id}`)).json();
    const slot = a.slots.find((s: { reason?: string }) => !s.reason);
    if (!slot) continue;
    const res = await r.post(base + "/bookings", {
      data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: svc.id, customer_name: "Sam Old", phone: "07700 900411", email: "sam.old@example.test", notes: "", date, start_min: slot.start_min, source: "TEST_BOOKING", quote: a.quote, notify: false },
    });
    expect(res.status(), await res.text()).toBe(201);
    visits.push((await res.json()).booking);
  }
  expect(visits.length).toBe(2);
  expect(visits[0].customer_id).toBeTruthy();
  expect(visits[1].customer_id).toBe(visits[0].customer_id);
  return { r, visits, customerId: visits[0].customer_id };
}

test("editing the customer record updates every appointment on the calendar", async () => {
  const { r, visits, customerId } = await world("Sync From Record");
  const cust = (await (await r.get(base + `/customers/${customerId}`)).json()).customer;
  const res = await r.put(base + `/customers/${customerId}`, {
    data: { name: "Samantha New", phone: "07700 900422", email: "sam.new@example.test", notes: "", tags: [], birthday: "", preferred_staff_id: "", marketing_opt_in: 0, version: cust.version },
  });
  expect(res.status(), await res.text()).toBe(200);
  for (const v of visits) {
    const b = (await (await r.get(base + `/bookings/${v.id}`)).json()).booking;
    expect(b).toMatchObject({ customer_name: "Samantha New", phone: "07700900422", email: "sam.new@example.test", customer_id: customerId });
  }
});

test("editing name / mobile on one appointment updates the customer and their other appointments", async () => {
  const { r, visits, customerId } = await world("Sync From Visit");
  const first = (await (await r.get(base + `/bookings/${visits[0].id}`)).json()).booking;
  const res = await r.patch(base + `/bookings/${first.id}/details`, {
    data: { customer_name: "Sam Corrected", phone: "07700 900433", notes: "", reason: "Customer gave new number", version: first.version },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).customer_updated).toBe(true);
  const cust = (await (await r.get(base + `/customers/${customerId}`)).json()).customer;
  expect(cust).toMatchObject({ name: "Sam Corrected", phone: "07700900433" });
  const other = (await (await r.get(base + `/bookings/${visits[1].id}`)).json()).booking;
  expect(other).toMatchObject({ customer_name: "Sam Corrected", phone: "07700900433", customer_id: customerId });
});

test("an appointment can't take another customer's mobile; nothing changes", async () => {
  const { r, visits, customerId } = await world("Sync Clash");
  const other = await r.post(base + "/customers", { data: { name: "Other Person", phone: "07700 900444", email: "other@example.test" } });
  expect(other.status(), await other.text()).toBe(201);
  const first = (await (await r.get(base + `/bookings/${visits[0].id}`)).json()).booking;
  const res = await r.patch(base + `/bookings/${first.id}/details`, {
    data: { customer_name: "Sam Old", phone: "07700 900444", notes: "", reason: "Typo test", version: first.version },
  });
  expect(res.status()).toBe(409);
  expect(await res.text()).toContain("merge");
  const cust = (await (await r.get(base + `/customers/${customerId}`)).json()).customer;
  expect(cust.phone).toBe("07700900411");
  const again = (await (await r.get(base + `/bookings/${visits[0].id}`)).json()).booking;
  expect(again).toMatchObject({ phone: "07700900411", version: first.version });
});

test("a notes-only change on an appointment leaves the customer alone", async () => {
  const { r, visits, customerId } = await world("Sync Notes");
  const before = (await (await r.get(base + `/customers/${customerId}`)).json()).customer;
  const first = (await (await r.get(base + `/bookings/${visits[0].id}`)).json()).booking;
  const res = await r.patch(base + `/bookings/${first.id}/details`, {
    data: { customer_name: first.customer_name, phone: first.phone, notes: "Prefers scissors", reason: "Note updated", version: first.version },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).customer_updated).toBe(false);
  const after = (await (await r.get(base + `/customers/${customerId}`)).json()).customer;
  expect(after.version).toBe(before.version);
});

test("re-saving a customer repairs appointments still showing old details (edited before the sync existed)", async () => {
  const { readFileSync } = await import("node:fs");
  const postgres = (await import("postgres")).default;
  const url = process.env.DATABASE_URL || readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
  const { r, visits, customerId } = await world("Sync Repair");
  // Simulate the old bug: the customer record was corrected but the appointments kept the typo.
  const sql = postgres(url, { max: 1 });
  await sql`update customers set name='Lloyd Mullins', version=version+1 where id=${customerId}`;
  await sql`update bookings set customer_name='Lloyd myllindt' where customer_id=${customerId}`;
  await sql.end();
  // Saving the customer with no changes at all must still bring every appointment back in line.
  const cust = (await (await r.get(base + `/customers/${customerId}`)).json()).customer;
  const res = await r.put(base + `/customers/${customerId}`, {
    data: { name: cust.name, phone: cust.phone, email: cust.email, notes: cust.notes || "", tags: [], birthday: "", preferred_staff_id: "", marketing_opt_in: 0, version: cust.version },
  });
  expect(res.status(), await res.text()).toBe(200);
  for (const v of visits) {
    const b = (await (await r.get(base + `/bookings/${v.id}`)).json()).booking;
    expect(b.customer_name).toBe("Lloyd Mullins");
  }
});

test("an ordinary re-save leaves appointments that are already correct untouched", async () => {
  const { r, visits, customerId } = await world("Sync Untouched");
  const before = (await (await r.get(base + `/bookings/${visits[0].id}`)).json()).booking;
  const cust = (await (await r.get(base + `/customers/${customerId}`)).json()).customer;
  const res = await r.put(base + `/customers/${customerId}`, {
    data: { name: cust.name, phone: cust.phone, email: cust.email, notes: "just a note", tags: [], birthday: "", preferred_staff_id: "", marketing_opt_in: 0, version: cust.version },
  });
  expect(res.status(), await res.text()).toBe(200);
  const after = (await (await r.get(base + `/bookings/${visits[0].id}`)).json()).booking;
  expect(after.version).toBe(before.version); // nobody with this appointment open gets a "record changed" clash
});
