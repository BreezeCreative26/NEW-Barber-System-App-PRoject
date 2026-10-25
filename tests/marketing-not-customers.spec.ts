import { test, expect, request } from "@playwright/test";
import { execSync } from "node:child_process";
import { base, origin, newShop } from "./shop";

// Marketing lists are marketing only. Uploading a CSV and sending to it must never create a customer,
// touch an existing one, or show anyone in a shop's customer list, search or exports.
const psql = (q: string) => execSync(`psql -h /tmp/pg -p 5433 -U postgres foliyo -Atc "${q}"`).toString().trim();
const csv = "Name,Mobile,Email\nPat Prospect,07700 900777,pat@prospect.test\nQuinn Lead,,quinn@prospect.test\nRae Mobile,07700 900888,\n";

test("shop campaign CSV: uploaded people are never added to the customer list", async () => {
  const { r, shop_id } = await newShop("Apart Cuts");
  const w = await (await r.get(base + "/workspace")).json();
  const slug = `apt-${crypto.randomUUID().slice(0, 10)}`;
  await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  await r.post(base + "/customers/import", { data: { csv: "Name,Phone,Email\nReal Customer,07700 900123,real@cust.test\n" } });
  const before = psql(`select count(*) from customers where shop_id='${shop_id}'`);

  const up = await (await r.post(base + "/announcements/contacts", { data: { csv } })).json();
  expect(up.added).toBe(3);
  const sent = await r.post(base + "/announcements/send", { data: { channel: "BOTH", audience: "NONE", contact_ids: up.ids, confirm: true, sms_ack: true } });
  expect(sent.status(), await sent.text()).toBeLessThan(300);

  // No customer rows created, none changed, nothing links a prospect to a customer.
  expect(psql(`select count(*) from customers where shop_id='${shop_id}'`)).toBe(before);
  expect(psql(`select count(*) from customers where shop_id='${shop_id}' and (email in ('pat@prospect.test','quinn@prospect.test') or phone like '%7700900777%' or phone like '%7700900888%')`)).toBe("0");
  // They are not in the customer list or its search.
  const list = JSON.stringify(await (await r.get(base + "/customers?q=prospect")).json());
  expect(list).not.toContain("prospect.test");
  const all = JSON.stringify(await (await r.get(base + "/customers")).json());
  expect(all).not.toContain("Pat Prospect");
  // They live only in the separate marketing table.
  expect(psql(`select count(*) from shop_campaign_contacts where shop_id='${shop_id}'`)).toBe("3");
});

test("platform marketing CSV: uploaded people are never customers or accounts", async () => {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const email = `mk-apart-${Date.now()}@ollo.test`;
  await r.post(origin + "/api/app/auth/signup", { data: { shop_name: "Apart Admin Shop", name: "Apart Admin", email, password: "Demo1234!Demo1234!", accept_legal: true } });
  psql(`insert into platform_admins(user_id,role,created_by,created_at) select id,'SUPER','t',1 from app_users where email='${email}'`);
  const cust = psql("select count(*) from customers"), users = psql("select count(*) from app_users"), shops = psql("select count(*) from shops");

  const imp = await (await r.post(origin + "/api/admin/marketing/import", { data: { csv: "Business,Owner,Phone,Email\nApart Barbers,Sam Apart,07700 900321,sam@apart-barbers.test\n", list_name: "Apart", basis: "test", confirm: true } })).json();
  expect(imp.created).toBe(1);
  const camp = await (await r.post(origin + "/api/admin/marketing/campaigns", { data: { name: "Apart", channel: "BOTH", list_name: "Apart" } })).json();
  const sent = await r.post(origin + `/api/admin/marketing/campaigns/${camp.id}/send`, { data: { confirm: true } });
  expect(sent.status(), await sent.text()).toBe(200);

  expect(psql("select count(*) from customers")).toBe(cust);
  expect(psql("select count(*) from app_users")).toBe(users);
  expect(psql("select count(*) from shops")).toBe(shops);
  expect(psql("select count(*) from customers where email='sam@apart-barbers.test' or phone like '%7700900321%'")).toBe("0");
  expect(psql("select count(*) from marketing_contacts where email='sam@apart-barbers.test'")).toBe("1");
});
