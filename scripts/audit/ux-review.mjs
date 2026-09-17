// UX review harness: seed a realistic shop through the real API, then screenshot every
// surface at desktop and phone widths into /tmp/ux/. Also logs console/page/HTTP errors.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const origin = "http://localhost:3000";
const base = origin + "/api/app";
mkdirSync("/tmp/ux", { recursive: true });
const b = await chromium.launch();
const errors = [];
async function seed(ctx) {
  const r = ctx.request;
  const H = { Origin: origin };
  const em = `rev-${crypto.randomUUID().slice(0, 6)}@ollo.test`;
  let res = await r.post(base + "/auth/signup", { headers: H, data: { shop_name: "Kingsland Barbers", name: "Dan Okafor", email: em, password: "Unique fictional test password 438!" } });
  if (res.status() !== 201) throw new Error("signup " + (await res.text()));
  let w = await (await r.get(base + "/workspace")).json();
  const own = w.staff[0];
  await r.put(base + `/staff/${own.id}`, { headers: H, data: { name: "Dan Okafor", role: "Owner & barber", version: own.version } });
  await r.post(base + "/staff", { headers: H, data: { name: "Marcus Reed", role: "Senior barber" } });
  await r.post(base + "/staff", { headers: H, data: { name: "Leo Grant", role: "Barber" } });
  const svcs = [
    ["Signature cut", "Hair", 30, 2800], ["Skin fade", "Hair", 45, 3200], ["Buzz cut", "Hair", 20, 1800],
    ["Beard trim", "Beard", 20, 1500], ["Hot towel shave", "Beard", 30, 2500], ["Cut & beard", "Combos", 60, 4200], ["Kids cut", "Hair", 30, 1800],
  ];
  for (const [name, category, duration_min, price_pence] of svcs) await r.post(base + "/services", { headers: H, data: { name, category, duration_min, price_pence } });
  w = await (await r.get(base + "/workspace")).json();
  const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday === 0 ? 0 : 1, starts: 540, ends: weekday === 6 ? 1020 : 1140, break_start: 780, break_end: 810 }));
  for (const s of w.staff) await r.put(base + `/staff/${s.id}/hours`, { headers: H, data: { version: s.version, rows: hours } });
  w = await (await r.get(base + "/workspace")).json();
  const today = w.today;
  const names = ["Tom Hardy", "Ade Bello", "Sam Fisher", "Jordan Lee", "Chris Nolan", "Ravi Patel", "Ben Carter", "Ollie Stone", "Kai Mensah", "Max Turner", "Luke Shaw", "Noah Reid"];
  let i = 0;
  const bookings = [];
  for (const st of w.staff) {
    for (const start of [570, 630, 720, 840, 930, 1020]) {
      const svc = w.services[(i + st.name.length) % w.services.length];
      const res = await r.post(base + "/bookings", { headers: H, data: { request_id: crypto.randomUUID(), staff_id: st.id, service_id: svc.id, customer_name: names[i % names.length], phone: `0770090${String(1000 + i).slice(-4)}`, date: today, start_min: start, source: "TEST_BOOKING", quote: { service_version: svc.version, shop_version: w.shop.version } } });
      if (res.status() !== 201) console.log("booking failed", res.status(), (await res.text()).slice(0, 120));
      if (res.status() === 201) bookings.push((await res.json()).booking);
      i++;
    }
  }
  await r.put(base + "/shop/online", { headers: H, data: { slug: "kingsland", online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  await r.put(base + "/shop/page", { headers: H, data: { strapline: "Sharp cuts. Straight talk. No fuss.", about: "Independent barbershop in Dalston since 2014. Walk-ins welcome when the chair is free; book ahead to be sure.", phone: "020 7946 0123", instagram: "kingslandbarbers", version: 0 } });
  return { bookings, slug: "kingsland" };
}
async function shoot(page, name, opts = {}) {
  await page.waitForTimeout(opts.wait ?? 500);
  await page.screenshot({ path: `/tmp/ux/${name}.png`, fullPage: opts.full ?? false });
  console.log("shot", name);
}
for (const [label, viewport] of [["desk", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  page.on("pageerror", (e) => errors.push(`${label} PAGEERROR ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${label} CONSOLE ${m.text().slice(0, 160)}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) errors.push(`${label} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(origin, "")}`); });
  await page.goto(origin + "/signin");
  await shoot(page, `${label}-00-signin`);
  await page.getByRole("tab", { name: /Create/ }).click().catch(() => {});
  await shoot(page, `${label}-01-signup`);
  const { bookings, slug } = await seed(ctx);
  await page.goto(origin + "/workspace");
  await page.waitForSelector(".timetable-slot, .week-view, .calendar-event", { timeout: 15000 }).catch(() => {});
  await shoot(page, `${label}-10-calendar`, { wait: 1500 });
  const nav = page.getByRole("navigation", { name: "Workspace sections" });
  for (const sec of ["Customers", "Team", "Services", "Shop page", "Pay", "Insights", "Settings", "Accounts"]) {
    const btn = nav.getByRole("button", { name: sec, exact: true });
    if (!(await btn.count())) { const more = page.getByRole("button", { name: /More/ }); if (await more.count()) await more.first().click(); }
    await nav.getByRole("button", { name: sec, exact: true }).click().catch(async () => page.getByRole("button", { name: sec, exact: true }).first().click().catch(() => {}));
    await shoot(page, `${label}-2${sec[0]}-${sec.replace(/\W+/g, "_").toLowerCase()}`, { full: true });
  }
  // New booking dialog
  await nav.getByRole("button", { name: "Appointments", exact: true }).click().catch(() => {});
  await page.getByRole("button", { name: "New booking", exact: true }).click().catch(() => {});
  await shoot(page, `${label}-30-new-booking`);
  await page.keyboard.press("Escape");
  // Appointment panel
  if (bookings[0]) {
    await page.locator(".calendar-event").first().click().catch(() => {});
    await shoot(page, `${label}-31-appointment-panel`);
    await page.keyboard.press("Escape");
  }
  // Public
  await page.goto(`${origin}/${slug}`);
  await shoot(page, `${label}-40-shop-page`, { full: true, wait: 1500 });
  await page.goto(`${origin}/book/${slug}`);
  await shoot(page, `${label}-41-book`, { full: true, wait: 1500 });
  await ctx.close();
}
console.log("\nERRORS:", errors.length ? errors : "none");
await b.close();
