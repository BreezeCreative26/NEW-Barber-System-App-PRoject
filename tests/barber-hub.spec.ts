// The barber page is where everything about one barber lives. These cover the rules behind it:
// a service is off for a barber until ticked, a barber's own price is a fixed price, only owners and
// managers change hours, categories are real and ordered, and new shop hours can follow through.
import { test, expect, request } from "@playwright/test";
import { base, origin, signup, seedCatalogue } from "./shop";
import { section } from "./fixture";

const pub = origin + "/api/public";
const day = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 8);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
type W = { staff: { id: string; name: string; version: number; active: number; follows_shop_hours?: number }[]; services: { id: string; name: string; category: string; price_pence: number }[]; service_rules: { staff_id: string; service_id: string; enabled: number; price_pence: number | null }[]; service_categories: { id: string; name: string; sort_order: number }[]; shop: { version: number; week_json: string; slug: string }; hours: { staff_id: string; weekday: number; enabled: number; starts: number; ends: number }[] };
const ws = async (r: Awaited<ReturnType<typeof request.newContext>>) => (await (await r.get(base + "/workspace")).json()) as W;

async function bare() {
  // Sign up and add a barber and two services, but tick nothing.
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  await signup(r, "Hub shop");
  let w = await ws(r);
  const own = w.staff[0];
  await r.put(base + `/staff/${own.id}`, { data: { name: "Jay Carter", role: "Barber", version: own.version } });
  await r.post(base + "/staff", { data: { name: "Marcus Reed", role: "Barber" } });
  for (const s of [{ name: "Cut", category: "Hair", price_pence: 2800, duration_min: 30 }, { name: "Beard", category: "Beard", price_pence: 1500, duration_min: 20 }]) {
    const res = await r.post(base + "/services", { data: s });
    expect(res.status(), await res.text()).toBe(201);
  }
  w = await ws(r);
  const slug = `hub-${crypto.randomUUID().slice(0, 10)}`;
  const on = await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  expect(on.status(), await on.text()).toBe(200);
  return { r, slug, w: await ws(r) };
}

test("a new service is off for every barber until someone ticks it; the barber's own price is fixed", async () => {
  const { r, slug, w } = await bare();
  const jay = w.staff.find((s) => s.name === "Jay Carter")!;
  const cut = w.services.find((s) => s.name === "Cut")!;
  expect(w.service_rules.filter((x) => x.enabled === 1)).toHaveLength(0);

  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const avail = (staff: string) => c.get(`${pub}/shops/${slug}/availability?date=${day()}&staff_id=${staff}&service_id=${cut.id}`);
  expect((await avail(jay.id)).status()).toBe(404);
  expect((await avail("any")).status()).toBe(409);

  // Tick Cut for Jay at a fixed £35 (the shop price is £28).
  const put = await r.put(base + "/service-rules", { data: { rules: [{ staff_id: jay.id, service_id: cut.id, enabled: 1, price_pence: 3500, duration_min: null }] } });
  expect(put.status(), await put.text()).toBe(200);
  const ok = await avail(jay.id);
  expect(ok.status(), await ok.text()).toBe(200);
  const body = await ok.json();
  expect(JSON.stringify(body)).toContain("3500");
  // Marcus still does not offer it; "any" now resolves to Jay only.
  const marcus = w.staff.find((s) => s.name === "Marcus Reed")!;
  expect((await avail(marcus.id)).status()).toBe(404);

  // Unticking removes the row: off means no row.
  await r.put(base + "/service-rules", { data: { rules: [{ staff_id: jay.id, service_id: cut.id, enabled: 0, price_pence: null, duration_min: null }] } });
  expect((await ws(r)).service_rules.some((x) => x.staff_id === jay.id && x.service_id === cut.id)).toBe(false);
  expect((await avail(jay.id)).status()).toBe(404);
});

test("only owners and managers change hours: a barber is refused everywhere", async () => {
  const owner = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await owner.post(base + "/auth/demo", { data: {} })).status()).toBe(201);
  const ow = await ws(owner);
  const barber = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await barber.post(base + "/auth/demo", { data: { as: "barber" } })).status()).toBe(201);
  const bw = await ws(barber);
  const s = bw.staff[0];
  const rows = Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: 1, starts: 540, ends: 1080, break_start: 540, break_end: 540 }));
  const change = { kind: "weekly", staff_id: s.id, change: { version: s.version, rows } };
  for (const [m, p, data] of [
    ["post", "/schedule/preview", change],
    ["post", "/schedule/apply", { change, decisions: [] }],
    ["put", `/staff/${s.id}/hours`, { version: s.version, rows }],
    ["post", `/staff/${s.id}/days-off`, { date: day(), reason: "x" }],
    ["put", "/service-rules", { rules: [{ staff_id: s.id, service_id: bw.services[0].id, enabled: 1, price_pence: 100, duration_min: null }] }],
    ["post", "/staff/follow-shop-hours/apply", {}],
    ["post", "/service-categories", { name: "Barber made" }],
  ] as [string, string, unknown][]) {
    const res = await (barber as never as Record<string, (u: string, o: unknown) => Promise<{ status(): number; text(): Promise<string> }>>)[m](base + p, { data });
    expect(res.status(), `${m} ${p}: ${await res.text()}`).toBe(403);
  }
  // The owner can.
  const o = ow.staff[0];
  const res = await owner.post(base + "/schedule/preview", { data: { kind: "weekly", staff_id: o.id, change: { version: o.version, rows } } });
  expect(res.status(), await res.text()).toBe(200);
});

test("categories are real: create, rename, reorder, delete only when empty, and the shop page follows the order", async () => {
  const { r, slug } = await bare();
  const make = async (name: string) => { const res = await r.post(base + "/service-categories", { data: { name } }); expect(res.status(), await res.text()).toBe(201); return (await res.json()).id as string; };
  expect((await r.post(base + "/service-categories", { data: { name: "Hair" } })).status()).toBe(409);
  const kids = await make("Kids");
  let w = await ws(r);
  const hair = w.service_categories.find((c) => c.name === "Hair")!;
  const beard = w.service_categories.find((c) => c.name === "Beard")!;
  // Beard first, then Hair, then Kids.
  expect((await r.put(base + "/service-categories/order", { data: { ids: [beard.id, hair.id, kids] } })).status()).toBe(200);
  const page = await (await request.newContext()).get(`${pub}/shops/${slug}`);
  const names = (await page.json()).services.map((s: { category: string }) => s.category);
  expect(names.indexOf("Beard")).toBeLessThan(names.indexOf("Hair"));
  // Rename carries the services.
  expect((await r.put(base + `/service-categories/${hair.id}`, { data: { name: "Haircuts", description: "" } })).status()).toBe(200);
  w = await ws(r);
  expect(w.services.find((s) => s.name === "Cut")!.category).toBe("Haircuts");
  // Delete: refused while it holds a service, fine when empty.
  expect((await r.delete(base + `/service-categories/${hair.id}`)).status()).toBe(409);
  expect((await r.delete(base + `/service-categories/${kids}`)).status()).toBe(200);
});

test("new shop hours can follow through to barbers who follow the shop, and leave the others alone", async () => {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  await signup(r, "Follow shop");
  await seedCatalogue(r);
  let w = await ws(r);
  const [a, b] = w.staff;
  const own0 = Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday === 0 ? 0 : 1, starts: 540, ends: 1080, break_start: 540, break_end: 540 }));
  // A follows the shop's hours; B has their own set. (The fixture saved both with their own hours.)
  expect((await r.put(base + `/staff/${a.id}/hours`, { data: { version: a.version, rows: own0, follow: 1 } })).status()).toBe(200);
  w = await ws(r);
  const b1 = w.staff.find((s) => s.id === b.id)!;
  const own = Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday === 0 ? 0 : 1, starts: 600, ends: 900, break_start: 600, break_end: 600 }));
  expect((await r.put(base + `/staff/${b.id}/hours`, { data: { version: b1.version, rows: own, follow: 0 } })).status()).toBe(200);
  w = await ws(r);
  const shopWeek = Array.from({ length: 7 }, (_, i) => ({ enabled: i === 0 ? 0 : 1, starts: 480, ends: 1200 }));
  const put = await r.put(base + "/shop", { data: { name: "Follow shop", address: "", timezone: "Europe/London", currency: "GBP", week: shopWeek, deposit_pence: 0, cancel_hours: 24, no_show_grace: 15, till_access: "OWNER", version: w.shop.version } });
  expect(put.status(), await put.text()).toBe(200);
  const res = await r.post(base + "/staff/follow-shop-hours/apply", { data: {} });
  expect(res.status(), await res.text()).toBe(200);
  w = await ws(r);
  const mon = (id: string) => w.hours.find((h) => h.staff_id === id && h.weekday === 1)!;
  expect(w.staff.find((s) => s.id === a.id)!.follows_shop_hours).toBe(1);
  expect([mon(a.id).starts, mon(a.id).ends]).toEqual([480, 1200]);
  expect([mon(b.id).starts, mon(b.id).ends]).toEqual([600, 900]);
});

test.describe("barber page on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("overview, hours and services fit the screen; ticking a service and saving works", async ({ page }) => {
    await page.request.post(base + "/auth/demo", { headers: { Origin: origin }, data: {} });
    await page.goto("/workspace");
    await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible({ timeout: 15000 });
    await section(page, "Team");
    await page.getByTestId("team-card").first().click();
    await expect(page.getByTestId("barber-overview")).toBeVisible();
    const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await fits();
    await page.getByRole("button", { name: "Hours", exact: true }).click();
    await expect(page.getByTestId("barber-hours")).toBeVisible();
    await expect(page.getByTestId("hours-day-1")).toBeVisible();
    await fits();
    await page.getByRole("button", { name: "Services", exact: true }).click();
    await expect(page.getByTestId("barber-services")).toBeVisible();
    await fits();
    const first = page.locator('[data-testid^="service-row-"]').first();
    const box = first.locator('input[type="checkbox"]');
    const was = await box.isChecked();
    await first.locator(".switch").click();
    expect(await box.isChecked()).toBe(!was);
    await expect(page.getByTestId("services-save")).toBeEnabled();
    await page.getByTestId("services-save").click();
    await expect(page.getByTestId("services-msg")).toContainText("saved");
    await expect(page.getByTestId("services-save")).toBeDisabled();
  });
});
