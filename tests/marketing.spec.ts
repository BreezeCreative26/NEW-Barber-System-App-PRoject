import { test, expect, request } from "@playwright/test";

// Marketing is for foliyo's own super admin: seed one, upload a CSV, check the engine, send a campaign
// in the dev mailbox (no real provider), then unsubscribe through the public link.
const origin = "http://localhost:3000";
const base = origin + "/api/admin";

async function adminCtx() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const email = `mk-admin-${Date.now()}@ollo.test`;
  const res = await r.post(origin + "/api/app/auth/signup", { data: { shop_name: "Mk Shop", name: "Mk Admin", email, password: "Demo1234!Demo1234!", accept_legal: true } });
  expect(res.status(), await res.text()).toBeLessThan(300);
  return { r, email };
}

test("marketing: csv in, engine extracts, campaign sends in the dev mailbox, unsubscribe sticks", async () => {
  const { r, email } = await adminCtx();
  // Not an admin yet: the panel does not exist.
  expect((await r.get(base + "/marketing/overview")).status()).toBe(404);
  const { execSync } = await import("node:child_process");
  execSync(`psql -h /tmp/pg -p 5433 -U postgres foliyo -c "delete from marketing_sends; delete from marketing_campaigns; delete from marketing_contacts"`);
  const uidOut = execSync(`psql -h /tmp/pg -p 5433 -U postgres foliyo -Atc "select id from app_users where email='${email}'"`).toString().trim();
  execSync(`psql -h /tmp/pg -p 5433 -U postgres foliyo -c "insert into platform_admins(user_id,role,created_by,created_at) values('${uidOut}','SUPER','test',1)"`);

  const csv = "Business,Owner,Phone,Email\nSharp Cuts,Dan Smith,07700 900123,dan@sharpcuts.test\nThe Old Barber,mike jones,\"01622 123456 / +44 7700 900456\",mike@oldbarber.test\nLandline Only,Pat,01622 000000,\nDup,Dan,447700900123,\n";
  const pv = await (await r.post(base + "/marketing/preview", { data: { csv } })).json();
  expect(pv.stats.contacts).toBe(3);
  expect(pv.stats.with_mobile).toBe(2);
  expect(pv.stats.duplicates_merged).toBe(1);

  const noConfirm = await r.post(base + "/marketing/import", { data: { csv, list_name: "Kent" } });
  expect(noConfirm.status()).toBe(400);
  const imp = await (await r.post(base + "/marketing/import", { data: { csv, list_name: "Kent", basis: "test", confirm: true } })).json();
  expect(imp.created).toBe(2); // the landline-only row cannot be texted or emailed, so it is skipped
  expect(imp.skipped).toBe(1);
  // A second upload does not duplicate anyone.
  const again = await (await r.post(base + "/marketing/import", { data: { csv, list_name: "Kent", basis: "test", confirm: true } })).json();
  expect(again.created).toBe(0);

  const made = await (await r.post(base + "/marketing/campaigns", { data: { name: "Launch", channel: "BOTH", list_name: "Kent" } })).json();
  const aud = await (await r.get(base + `/marketing/campaigns/${made.id}/audience`)).json();
  expect(aud.sms).toBe(2);
  expect(aud.email).toBe(2);
  expect(aud.sms_text).toContain("Reply STOP");
  expect(aud.email_html).toContain("/u/");
  expect(aud.email_html.toLowerCase()).toContain("unsubscribe");

  expect((await r.post(base + `/marketing/campaigns/${made.id}/send`, { data: {} })).status()).toBe(400);
  const sent = await r.post(base + `/marketing/campaigns/${made.id}/send`, { data: { confirm: true } });
  expect(sent.status(), await sent.text()).toBe(200);
  const ov = await (await r.get(base + "/marketing/overview")).json();
  const camp = ov.campaigns.find((c: any) => c.id === made.id);
  expect(camp.sent + camp.queued).toBe(4); // emails now; texts wait if the UK window is closed

  // Unsubscribe via the public link: the contact is never queued again.
  const tok = execSync(`psql -h /tmp/pg -p 5433 -U postgres foliyo -Atc "select unsub_token from marketing_contacts where email='dan@sharpcuts.test'"`).toString().trim();
  const page = await r.get(origin + `/u/${tok}`);
  expect(await page.text()).toContain("Unsubscribe me");
  const done = await r.post(origin + `/u/${tok}`);
  expect(await done.text()).toContain("You are unsubscribed");
  const ov2 = await (await r.get(base + "/marketing/overview")).json();
  expect(ov2.totals.unsubscribed).toBe(1);
  const again2 = await (await r.get(base + `/marketing/campaigns/${made.id}/audience`)).json();
  expect(again2.email).toBe(1);
});
