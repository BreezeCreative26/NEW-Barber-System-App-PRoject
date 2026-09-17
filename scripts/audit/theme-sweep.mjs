// Theme sweep: for every mode × accent (and a couple of fonts) run axe on every customer-facing page
// of the demo shop, and print failing colour pairs. Usage: node scripts/audit/theme-sweep.mjs [quick]
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { execSync } from "node:child_process";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5433/ollo";
const origin = "http://localhost:3000";
const quick = process.argv.includes("quick");
const modes = ["light", "dark"], accents = quick ? ["ollo", "ink"] : ["ollo", "ink", "sage", "clay", "plum", "slate"];
const fonts = quick ? ["condensed"] : ["modern", "editorial", "condensed"];
function setTheme(mode, accent, font) {
  const theme = JSON.stringify({ font, mode, corners: "soft", hero: "editorial", logo: "auto" });
  execSync(`psql "${DB}" -Atqc "update shop_pages set accent='${accent}', theme_json='${theme}' where shop_id=(select id from shops where slug='demo')"`);
}
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
// a manage token: book something through the API first
const rs = await (await p.request.get(origin + "/api/public/shops/demo")).json();
const svc = rs.services[0], st = rs.staff[0];
const av = await (await p.request.get(origin + `/api/public/shops/demo/availability?service_id=${svc.id}&staff_id=${st.id}&date=${rs.today}`)).json().catch(()=>null);
let manageUrl = null;
try {
  const days = await (await p.request.get(origin + `/api/public/shops/demo/days?service_id=${svc.id}&staff_id=${st.id}&from=${rs.today}`)).json();
  const day = (days.days || []).find((d) => d.open > 0) || null;
  const slots = day ? await (await p.request.get(origin + `/api/public/shops/demo/availability?service_id=${svc.id}&staff_id=${st.id}&date=${day.date}`)).json() : null;
  const slot = slots?.slots?.find((s) => s.available !== false) || slots?.slots?.[0];
  if (slot) {
    const r = await p.request.post(origin + "/api/public/shops/demo/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), service_id: svc.id, staff_id: st.id, date: day.date, start_min: slot.start_min ?? slot, customer_name: "Sweep Tester", phone: "07700900999", quote: { service_version: svc.version, shop_version: rs.shop.version } } });
    const j = await r.json(); if (j.manage_token) manageUrl = `${origin}/manage/${j.manage_token}`;
  }
} catch {}
const pages = [["shop", `${origin}/demo`], ["book", `${origin}/book/demo`], ["me-signin", `${origin}/demo/me`], ...(manageUrl ? [["manage", manageUrl]] : [])];
const failures = [];
for (const mode of modes) for (const accent of accents) for (const font of fonts) {
  setTheme(mode, accent, font);
  const record = async (name) => {
    const res = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa"]).analyze();
    for (const v of res.violations) for (const n of v.nodes) {
      const d = n.any[0]?.data || {};
      failures.push(`${mode}/${accent}/${font} ${name} | ${v.id} | ${n.target.join(" ").slice(0, 80)} | ${d.fgColor || ""} on ${d.bgColor || ""} ${d.contrastRatio ? d.contrastRatio.toFixed(2) : ""} | ${n.html.replace(/\s+/g, " ").slice(0, 60)}`);
    }
  };
  for (const [name, url] of pages) {
    await p.goto(url, { waitUntil: "networkidle" }); await p.waitForTimeout(400);
    await record(name);
    if (name === "book") {
      await p.getByRole("button", { name: /Choose your barber/i }).first().click().catch(() => {}); await p.waitForTimeout(500); await record("book-barber");
      await p.getByRole("button", { name: /Find a time/i }).first().click().catch(() => {}); await p.waitForTimeout(900); await record("book-time");
      const chip = p.locator(".next-chip").first(); if (await chip.count()) { await chip.click(); await p.waitForTimeout(600); }
      await p.getByRole("button", { name: /Your details/i }).first().click().catch(() => {}); await p.waitForTimeout(500); await record("book-details");
    }
  }
}
// restore Northline
setTheme("dark", "ink", "condensed");
console.log(failures.length ? failures.join("\n") : "CLEAN");
console.log(`\n${failures.length} violations across ${modes.length * accents.length * fonts.length * pages.length} page renders (manage: ${!!manageUrl})`);
await b.close();
