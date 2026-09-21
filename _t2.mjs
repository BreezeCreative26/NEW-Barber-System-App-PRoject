import { chromium } from "@playwright/test";
import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" }); config();
const origin = "http://localhost:3000";
const browser = await chromium.launch(); const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push("PAGEERR " + e.message)); page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("response", async (r) => { if (r.url().includes("/api/admin") && r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(origin, "")} ${(await r.text()).slice(0, 160)}`); });
const H = { Origin: origin };
const fx = await (await page.request.post(origin + "/api/app/auth/demo", { headers: H, data: { fixture: true, as: "owner" } })).json();
const w = await (await page.request.get(origin + "/api/app/workspace", { headers: H })).json();
const sql = postgres(process.env.DIRECT_URL || process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
await sql`INSERT INTO platform_admins(user_id,role,created_by,created_at) VALUES(${w.account.user_id},'SUPER','test',${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET role='SUPER'`;
const shopId = fx.shop_id;
const api = async (m, p, d) => { const r = await page.request.fetch(origin + "/api/admin" + p, { method: m, headers: H, data: d }); return { s: r.status(), j: await r.json().catch(() => ({})) }; };
const mails = async (tpl) => (await sql`SELECT template, recipient, subject FROM notifications WHERE shop_id=${shopId} AND template=${tpl} ORDER BY created_at DESC`).map((r) => `${r.template}→${r.recipient}: ${r.subject}`);

// trial ending in 2 days → sweep → trial_ending email
await sql`UPDATE shop_subscriptions SET trial_ends_at=${Date.now() + 2 * 86400000} WHERE shop_id=${shopId}`;
let r = await api("POST", "/sweep", {}); console.log("sweep1:", r.s, r.j, mails("trial_ending"));
r = await api("POST", "/sweep", {}); console.log("sweep2 (no dup):", (await mails("trial_ending")).length === 1);
// trial ended → sweep → trial_ended + INFO alert
await sql`UPDATE shop_subscriptions SET trial_ends_at=${Date.now() - 3600000} WHERE shop_id=${shopId}`;
r = await api("POST", "/sweep", {}); console.log("trial ended mail:", await mails("trial_ended"));
// past due → overdue mail + WARN; beyond grace → readonly + CRIT
await sql`UPDATE shop_subscriptions SET status='PAST_DUE', past_due_since=${Date.now() - 1000}, activated_at=${Date.now()} WHERE shop_id=${shopId}`;
r = await api("POST", "/sweep", {}); console.log("overdue mail:", await mails("payment_overdue"));
await sql`UPDATE shop_subscriptions SET past_due_since=${Date.now() - 8 * 86400000} WHERE shop_id=${shopId}`;
r = await api("POST", "/sweep", {}); console.log("readonly mail:", await mails("account_readonly"));
r = await api("GET", "/alerts"); console.log("alerts:", r.j.alerts.filter((a) => a.shop_id === shopId).map((a) => `${a.severity} ${a.kind}`));
const ov = await api("GET", "/overview"); console.log("overview alerts:", ov.j.alerts);
// trend
r = await api("GET", "/trend?days=30"); console.log("trend snapshots:", r.j.snapshots.length, "last30:", r.j.last_30d);
// exports
for (const p of ["/export/shops.csv", "/export/invoices.csv?from=2026-01-01&to=2026-12-31", "/export/usage.csv?period=2026-09"]) { const x = await page.request.get(origin + "/api/admin" + p); console.log(p.split("?")[0], x.status(), x.headers()["content-type"], (await x.text()).split("\n").length, "lines"); }
// broadcast to PAST_DUE shops
r = await api("POST", "/broadcasts/preview", { status: ["PAST_DUE"] }); console.log("segment preview:", r.j.count);
r = await api("POST", "/broadcasts", { subject: "Heads up: new invoice layout", body: "We've refreshed invoices.\n\nNothing you need to do — your next invoice just looks clearer.", cta_label: "See your billing", cta_url: origin + "/workspace", segment: { status: ["PAST_DUE"] } }); const bid = r.j.id; console.log("draft:", r.s);
r = await api("POST", `/broadcasts/${bid}/test`, { to: "me@ollo.test" }); console.log("test send:", r.s, r.j);
r = await api("POST", `/broadcasts/${bid}/send`, { reason: "Announcing invoice refresh" }); console.log("send:", r.s, r.j);
console.log("broadcast mails to shop:", await mails("broadcast"));
r = await api("POST", `/broadcasts/${bid}/send`, { reason: "again" }); console.log("resend blocked:", r.s);
// UI
await page.goto(origin + "/admin"); await page.getByTestId("admin-overview").waitFor(); await page.getByTestId("admin-trend").waitFor(); await page.waitForTimeout(600); await page.screenshot({ path: "/tmp/t2-1.png", fullPage: true });
await page.goto(origin + "/admin/alerts"); await page.getByTestId("admin-alerts").waitFor(); await page.waitForTimeout(400); console.log("UI alerts:", await page.getByTestId("admin-alert").count()); await page.screenshot({ path: "/tmp/t2-2.png", fullPage: true });
await page.getByTestId("admin-alert").first().getByRole("button", { name: "Acknowledge" }).click(); await page.waitForTimeout(500); console.log("after ack:", await page.getByTestId("admin-alert").count());
await page.goto(origin + "/admin/broadcasts"); await page.getByTestId("admin-broadcasts").waitFor(); await page.waitForTimeout(600); console.log("UI broadcasts:", await page.getByTestId("admin-broadcast").count(), (await page.getByTestId("admin-segment-preview").innerText()).slice(0, 60)); await page.screenshot({ path: "/tmp/t2-3.png", fullPage: true });
await sql.end(); console.log("errors:", errs); await browser.close();
