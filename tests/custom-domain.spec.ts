// A shop's own web address, end to end against stand-in Vercel and Resend servers (nothing real is
// contacted, nothing real is sent). Needs the app started with the stub env, see docs/GO_LIVE.md:
//   node tests/support/provider-stub.mjs &
//   DOMAINS_VERCEL_TOKEN=t DOMAINS_VERCEL_PROJECT_ID=prj DOMAINS_VERCEL_URL=http://localhost:4010 \
//   DOMAINS_RESEND_KEY=k DOMAINS_RESEND_URL=http://localhost:4010 RESEND_API_KEY=k \
//   RESEND_API_URL=http://localhost:4010/emails MAIL_FROM="foliyo <hello@mail.foliyo.test>" ...
// Skips itself when the stub or the env is not there.
import { test, expect, request } from "@playwright/test";
import { execSync } from "node:child_process";
import { base, origin, newShop, customerIdentity } from "./shop";

const STUB = process.env.PROVIDER_STUB || "http://localhost:4010";
const psql = (q: string) => execSync(`psql -h /tmp/pg -p 5433 -U postgres foliyo -Atc "${q}"`).toString().trim();
const ctl = async (path: string, data?: unknown) => (await (await request.newContext()).post(STUB + path, { data })).json();
let SUBJ = "";
const sent = async () => (await (await request.newContext()).get(STUB + "/_ctl/emails")).json() as Promise<{ from: string; to: string[]; subject: string; html: string; text: string }[]>;

test.describe.configure({ mode: "serial" });

let up = false;
test.beforeAll(async () => {
  try { up = (await (await request.newContext()).get(STUB + "/_ctl/emails")).ok(); } catch { up = false; }
  if (up) await ctl("/_ctl/reset");
});

async function shopWithPage(name: string) {
  const s = await newShop(name);
  const w = await (await s.r.get(base + "/workspace")).json();
  const slug = `dom-${crypto.randomUUID().slice(0, 10)}`;
  expect((await s.r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
  const owner = w.account.user_id as string;
  psql(`INSERT INTO platform_admins(user_id,role,created_by,created_at) VALUES('${owner}','SUPER','test',${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET role='SUPER'`);
  return { ...s, slug };
}
const grant = (s: { r: Awaited<ReturnType<typeof newShop>>["r"]; shop_id: string }) =>
  s.r.post(`${origin}/api/admin/shops/${s.shop_id}/features`, { headers: { Origin: origin }, data: { key: "custom_domain", mode: "GRANT", reason: "Test shop given its own domain" } });

// An announcement to every opted-in customer, released and delivered now.
async function announce(s: { r: Awaited<ReturnType<typeof newShop>>["r"]; shop_id: string }, subject: string) {
  SUBJ = subject;
  const res = await s.r.post(base + "/announcements/send", { data: { kind: "custom", channel: "EMAIL", audience: "ALL", subject, body: "Hello from {shop}. Book any time.", send_at: Date.now() + 3600000, confirm: true } });
  expect(res.status(), await res.text()).toBe(200);
  psql(`update notifications set next_attempt_at=1 where shop_id='${s.shop_id}' and status='QUEUED'`);
  await s.r.get(origin + "/api/cron/messages", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
}

test("own domain: gated, connected, verified, then customer emails and links follow it automatically", async () => {
  test.skip(!up, "provider stub not running");
  const s = await shopWithPage("Fresh Fades");
  const domain = `book-${crypto.randomUUID().slice(0, 8)}.example.test`;
  const me = customerIdentity("Olly Old");
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await c.post(`${origin}/api/public/shops/${s.slug}/account/register`, { data: { ...me, password: "Fictional-test-pass-2026!", marketing_opt_in: 1 } })).status()).toBe(201);

  // Off by default: the shop is told, politely.
  const view0 = await (await s.r.get(base + "/domain")).json();
  expect(view0).toMatchObject({ allowed: false, configured: true, domain: null });
  const refused = await s.r.put(base + "/domain", { data: { domain } });
  expect(refused.status()).toBe(403);

  // Granted by foliyo: now it can connect. Bad input is refused, a good domain returns the DNS records to add.
  expect((await grant(s)).status()).toBe(200);
  expect((await s.r.put(base + "/domain", { data: { domain: "not a domain" } })).status()).toBe(400);
  expect((await s.r.put(base + "/domain", { data: { domain: `${s.slug}.localhost` } })).status()).toBe(400);
  const put = await s.r.put(base + "/domain", { data: { domain } });
  expect(put.status(), await put.text()).toBe(200);
  const v1 = (await put.json()).domain;
  expect(v1).toMatchObject({ domain, web: "PENDING", mail: "PENDING", live: false });
  expect(v1.records.some((r: any) => r.purpose === "web" && r.type === "CNAME" && r.value === "cname.vercel-dns.com")).toBe(true);
  expect(v1.records.some((r: any) => r.purpose === "email" && r.type === "TXT")).toBe(true);

  // Until it is live nothing changes: the email still says the foliyo address and comes from foliyo.
  await announce(s, "Before the switch");
  let mail = (await sent()).filter((m) => m.to[0] === me.email && m.subject === SUBJ);
  expect(mail.length).toBe(1);
  expect(mail[0].from).toContain("hello@mail.foliyo.test");
  expect(mail[0].html).toContain(`${s.slug}.localhost:3000`);
  expect(mail[0].html).not.toContain(domain);
  // An unfinished domain does not serve the shop yet.
  const unknown = await request.newContext();
  expect(await (await unknown.get(origin + "/book", { headers: { Host: domain }, maxRedirects: 0 })).text()).not.toContain("Fresh Fades");

  // DNS lands: the stub flips both providers to verified, the owner's next check picks it up.
  await ctl("/_ctl/verify", { domain });
  await new Promise((ok) => setTimeout(ok, 8500)); // "Check now" is throttled to once per 8 seconds
  const chk = await (await s.r.post(base + "/domain/check", { data: {} })).json();
  expect(chk.domain).toMatchObject({ web: "VERIFIED", mail: "VERIFIED", live: true });

  // The shop is served on its own domain (with the customer pages only); staff paths bounce to the foliyo address.
  const page = await unknown.get(origin + "/", { headers: { Host: domain }, maxRedirects: 0 });
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain(`https://${domain}`); // canonical / share URL
  const staff = await unknown.get(origin + "/workspace", { headers: { Host: domain }, maxRedirects: 0 });
  expect(staff.status()).toBe(302);
  expect(staff.headers().location).toContain(`${s.slug}.localhost`);
  // The foliyo address now sends customers to the new home.
  const old = await unknown.get(origin + "/book", { headers: { Host: `${s.slug}.localhost:3000` }, maxRedirects: 0 });
  expect(old.status()).toBe(301);
  expect(old.headers().location).toBe(`https://${domain}/book`);
  // And "share your link" hands out the new address.
  expect(JSON.stringify(await (await s.r.get(base + "/setup/share")).json())).toContain(`https://${domain}`);

  // Emails switch by themselves: sender is bookings@<domain>, customer links are on the domain.
  await announce(s, "After the switch");
  mail = (await sent()).filter((m) => m.to[0] === me.email && m.subject === SUBJ);
  const after = mail[mail.length - 1];
  expect(after.from).toContain(`<bookings@${domain}>`);
  expect(after.html).toContain(`https://${domain}/book`);
  expect(after.html).toContain(`https://${domain}/u/c/`);
  expect(after.html).not.toContain(`${s.slug}.localhost`);

  // If Resend later refuses that sender, the message still goes, from foliyo.
  await ctl("/_ctl/reject", { on: true });
  await announce(s, "Sender trouble");
  mail = (await sent()).filter((m) => m.to[0] === me.email && m.subject === SUBJ);
  expect(mail[0].from).toContain(`<bookings@${domain}>`);
  expect(mail[mail.length - 1].from).toContain("hello@mail.foliyo.test");
  expect(psql(`select status from notifications where shop_id='${s.shop_id}' and subject='Sender trouble'`)).toBe("SENT");
  await ctl("/_ctl/reject", { on: false });

  // Another shop can't take a live domain.
  const other = await shopWithPage("Other Cuts");
  expect((await grant(other)).status()).toBe(200);
  expect((await other.r.put(base + "/domain", { data: { domain } })).status()).toBe(409);

  // Disconnect: back to the foliyo address everywhere, no restart needed.
  expect((await s.r.delete(base + "/domain")).status()).toBe(200);
  await announce(s, "Back to foliyo");
  mail = (await sent()).filter((m) => m.to[0] === me.email && m.subject === SUBJ);
  const back = mail[mail.length - 1];
  expect(back.from).toContain("hello@mail.foliyo.test");
  expect(back.html).toContain(`${s.slug}.localhost:3000`);
  expect(psql(`select count(*) from shop_domains where shop_id='${s.shop_id}'`)).toBe("0");
  expect(psql(`select count(*) from audit_events where entity_id='${s.shop_id}' and action in ('DOMAIN_ADDED','DOMAIN_REMOVED')`)).toBe("2");
});

test("settings screen: locked until foliyo switches it on, then connect, see the DNS records, disconnect", async ({ page }) => {
  test.skip(!up, "provider stub not running");
  const { enterNewShop } = await import("./shop");
  await enterNewShop(page, "Screen Cuts");
  const w = await (await page.request.get(base + "/workspace")).json();
  psql(`INSERT INTO platform_admins(user_id,role,created_by,created_at) VALUES('${w.account.user_id}','SUPER','test',${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET role='SUPER'`);
  await page.goto("/workspace");
  await page.getByRole("button", { name: /settings/i }).first().click().catch(() => null);
  await page.getByText("Your web address", { exact: false }).first().click();
  await expect(page.getByTestId("domain-locked")).toBeVisible();

  expect((await page.request.post(`${origin}/api/admin/shops/${w.shop.id}/features`, { headers: { Origin: origin }, data: { key: "custom_domain", mode: "GRANT", reason: "Screen test" } })).status()).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: /settings/i }).first().click().catch(() => null);
  await page.getByText("Your web address", { exact: false }).first().click();
  const domain = `shop-${crypto.randomUUID().slice(0, 8)}.example.test`;
  await page.getByTestId("domain-input").fill(domain);
  await page.getByTestId("domain-save").click();
  await expect(page.getByTestId("domain-status")).toBeVisible();
  await expect(page.getByTestId("domain-records")).toContainText("cname.vercel-dns.com");
  await expect(page.getByTestId("domain-records")).toContainText("resend._domainkey");
  await expect(page.getByTestId("domain-web")).toContainText(/waiting|pending|checking/i);
  await page.screenshot({ path: "test-results/domain-panel.png", fullPage: true });
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("domain-remove").click();
  await expect(page.getByTestId("domain-input")).toBeVisible();
});
