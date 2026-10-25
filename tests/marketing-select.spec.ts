import { test, expect, request } from "@playwright/test";
import { execSync } from "node:child_process";

// The full contact list on the platform Marketing tab: page through it, search, select people (or everyone
// who matches, beyond the page on screen), and message only them, by email and text, in the dev mailbox.
const origin = "http://localhost:3000";
const base = origin + "/api/admin";
const psql = (q: string) => execSync(`psql -h /tmp/pg -p 5433 -U postgres foliyo -Atc "${q}"`).toString().trim();

async function superAdmin() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const email = `mk-sel-${Date.now()}@ollo.test`;
  const res = await r.post(origin + "/api/app/auth/signup", { data: { shop_name: "Mk Sel Shop", name: "Mk Sel", email, password: "Demo1234!Demo1234!", accept_legal: true } });
  expect(res.status(), await res.text()).toBeLessThan(300);
  const uid = psql(`select id from app_users where email='${email}'`);
  psql(`insert into platform_admins(user_id,role,created_by,created_at) values('${uid}','SUPER','test',1)`);
  return r;
}

function csvOf(count: number) {
  const rows = ["Business,Owner,Phone,Email"];
  for (let i = 0; i < count; i++) {
    const both = i % 3 === 0, mobileOnly = i % 3 === 1;
    rows.push(`Shop ${i},Person ${i},${both || mobileOnly ? "07700 9" + String(10000 + i).slice(-5) : ""},${!mobileOnly ? `p${i}@sel.test` : ""}`);
  }
  return rows.join("\n");
}

test("marketing: full contact list pages, searches, selects everyone who matches, and sends only to the picked people", async () => {
  psql("delete from marketing_campaign_contacts; delete from marketing_sends; delete from marketing_campaigns; delete from marketing_contacts");
  const r = await superAdmin();
  const imp = await (await r.post(base + "/marketing/import", { data: { csv: csvOf(120), list_name: "Big", basis: "test", confirm: true } })).json();
  expect(imp.created).toBe(120);

  // Paged: 50 a page, with the true total.
  const p1 = await (await r.get(base + "/marketing/contacts?limit=50&offset=0")).json();
  expect(p1.total).toBe(120);
  expect(p1.contacts).toHaveLength(50);
  const p3 = await (await r.get(base + "/marketing/contacts?limit=50&offset=100")).json();
  expect(p3.contacts).toHaveLength(20);
  expect(new Set([...p1.contacts, ...p3.contacts].map((c: any) => c.id)).size).toBe(70);

  // Search and "has" filters.
  const found = await (await r.get(base + "/marketing/contacts?q=" + encodeURIComponent("shop 7"))).json();
  expect(found.total).toBeGreaterThan(0);
  expect(found.contacts.every((c: any) => /shop 7/i.test(c.business))).toBe(true);
  const both = await (await r.get(base + "/marketing/contacts?has=both")).json();
  expect(both.total).toBe(40);

  // Select all who match returns every id, not just the page.
  const all = await (await r.get(base + "/marketing/contacts?ids=1")).json();
  expect(all.ids).toHaveLength(120);

  // Opted-out people drop out of "can be contacted" and can never be selected.
  const victim = p1.contacts.find((c: any) => c.email && c.phone);
  await r.post(base + `/marketing/contacts/${victim.id}/unsubscribe`);
  expect((await (await r.get(base + "/marketing/contacts?ids=1")).json()).ids).toHaveLength(119);
  expect((await (await r.get(base + "/marketing/contacts?status=optout")).json()).total).toBe(1);

  // A campaign to 4 hand-picked people (two with both, one mobile-only, one email-only), plus the opted-out one.
  const people = (await (await r.get(base + "/marketing/contacts?status=active&has=both&limit=2")).json()).contacts.map((c: any) => c.id);
  const mobileOnly = (await (await r.get(base + "/marketing/contacts?q=" + encodeURIComponent("shop 1") + "&status=active&has=mobile&limit=200")).json()).contacts.find((c: any) => !c.email);
  const emailOnly = (await (await r.get(base + "/marketing/contacts?status=active&has=email&limit=200")).json()).contacts.find((c: any) => !c.phone);
  const picked = [...people, mobileOnly.id, emailOnly.id, victim.id];
  const made = await (await r.post(base + "/marketing/campaigns", { data: { name: "Picked", channel: "BOTH", list_name: "Big" } })).json();
  const put = await (await r.put(base + `/marketing/campaigns/${made.id}/contacts`, { data: { contact_ids: picked } })).json();
  expect(put.selected).toBe(4); // the opted-out person was refused
  const aud = await (await r.get(base + `/marketing/campaigns/${made.id}/audience`)).json();
  expect(aud.contacts).toBe(4);
  expect(aud.sms).toBe(3);   // two with both + mobile-only
  expect(aud.email).toBe(3); // two with both + email-only

  const sent = await r.post(base + `/marketing/campaigns/${made.id}/send`, { data: { confirm: true } });
  expect(sent.status(), await sent.text()).toBe(200);
  expect(Number(psql(`select count(*) from marketing_sends where campaign_id='${made.id}'`))).toBe(6);
  // The same person can get both an email and a text.
  expect(Number(psql(`select count(distinct contact_id) from marketing_sends where campaign_id='${made.id}' and channel='EMAIL' and contact_id in (select contact_id from marketing_sends where campaign_id='${made.id}' and channel='SMS')`))).toBe(2);
  // Sent campaigns can't have their recipients swapped.
  expect((await r.put(base + `/marketing/campaigns/${made.id}/contacts`, { data: { contact_ids: [] } })).status()).toBe(409);

  // With no one picked, a campaign still goes to the whole list.
  const whole = await (await r.post(base + "/marketing/campaigns", { data: { name: "Whole", channel: "EMAIL", list_name: "Big" } })).json();
  const wa = await (await r.get(base + `/marketing/campaigns/${whole.id}/audience`)).json();
  expect(wa.email).toBe(79); // 80 with an email minus the opted-out person
});

test("marketing screen: tick people in the full list, select all who match, and start a campaign from them", async ({ browser }) => {
  psql("delete from marketing_campaign_contacts; delete from marketing_sends; delete from marketing_campaigns; delete from marketing_contacts");
  const r = await superAdmin();
  await r.post(base + "/marketing/import", { data: { csv: csvOf(60), list_name: "Screen", basis: "test", confirm: true } });
  const ctx = await browser.newContext({ storageState: await r.storageState() });
  const page = await ctx.newPage();
  await page.goto(origin + "/admin/marketing");
  await expect(page.getByTestId("mk-contacts-table")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("mk-row-check")).toHaveCount(50);

  await page.getByTestId("mk-select-page").check();
  await expect(page.getByTestId("mk-picked-count")).toHaveText("50");
  await page.getByTestId("mk-select-all").click();
  await expect(page.getByTestId("mk-picked-count")).toHaveText("60");
  await page.getByTestId("mk-clear").click();
  await expect(page.getByTestId("mk-picked-count")).toHaveText("0");

  await page.getByTestId("mk-search").fill("Shop 5");
  await expect(page.getByTestId("mk-row-check").first()).toBeVisible();
  await page.getByTestId("mk-row-check").first().check();
  await expect(page.getByTestId("mk-picked-count")).toHaveText("1");
  await page.getByTestId("mk-start-campaign").click();
  await expect(page.getByTestId("mk-picked-note")).toContainText("1 hand-picked person");
  await ctx.close();
});
