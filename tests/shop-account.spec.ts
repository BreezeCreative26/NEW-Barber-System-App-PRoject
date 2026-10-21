import { expect, request, test } from "@playwright/test";
import { base, origin, PASSWORD, email } from "./shop";

const json = { origin };
async function ctx() { return request.newContext({ extraHTTPHeaders: json }); }

test("business signup gives a free shop login with no barber profile, then the owner is invited", async () => {
  const shop = await ctx();
  const biz = email();
  const res = await shop.post(base + "/auth/signup", { data: { accept_legal: true, shop_name: "Front Desk Co", account_type: "BUSINESS", shop_login: true, email: biz, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  const me = (await (await shop.get(base + "/auth/me")).json()).account;
  expect(me.shop_account).toBe(true);
  expect(me.name).toBe("Front Desk Co");
  expect(me.role).toBe("MANAGER"); // setup powers until the owner joins
  const w = await (await shop.get(base + "/workspace")).json();
  expect(w.staff).toHaveLength(0); // no barber profile, so no seat

  const s = await shop.post(base + "/staff", { data: { name: "Olly Owner", role: "Owner" } });
  const staffId = (await s.json()).id as string;
  const inv = await shop.post(base + "/auth/invites", { data: { staff_id: staffId, email: email(), role: "OWNER" } });
  expect(inv.status(), await inv.text()).toBe(201);
  const { token } = await inv.json();
  const ownerEmail = email();
  const owner = await ctx();
  const acc = await owner.post(base + "/auth/accept", { data: { email: ownerEmail, password: PASSWORD, name: "Olly Owner", token, accept_legal: true } });
  // The invite was bound to the first address (email invites are bound), so a different address is refused.
  expect(acc.status()).toBe(400);
  const inv2 = await shop.post(base + "/auth/invites", { data: { staff_id: staffId, email: ownerEmail, role: "OWNER" } });
  const ok = await owner.post(base + "/auth/accept", { data: { email: ownerEmail, password: PASSWORD, name: "Olly Owner", token: (await inv2.json()).token, accept_legal: true } });
  expect(ok.ok(), await ok.text()).toBe(true);
  expect((await (await owner.get(base + "/auth/me")).json()).account.role).toBe("OWNER");
  // The shop login drops to front-desk level and cannot name a second owner.
  expect((await (await shop.get(base + "/auth/me")).json()).account.role).toBe("RECEPTION");
  const again = await shop.post(base + "/auth/invites", { data: { staff_id: staffId, email: email(), role: "OWNER" } });
  expect(again.status()).toBe(403);
});

test("an individual account is one person and cannot add barbers", async () => {
  const solo = await ctx();
  const res = await solo.post(base + "/auth/signup", { data: { accept_legal: true, shop_name: "Just Me", name: "Solo Sam", account_type: "INDIVIDUAL", email: email(), password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  const me = (await (await solo.get(base + "/auth/me")).json()).account;
  expect(me.role).toBe("OWNER");
  const add = await solo.post(base + "/staff", { data: { name: "Second Barber", role: "Barber" } });
  expect(add.status()).toBe(403);
  const bill = await (await solo.get(base + "/billing")).json().catch(() => null);
  if (bill?.plan) expect(bill.plan.id).toBe("solo");
});

test("a barber sees only their own insights until the owner grants more", async () => {
  const o = await ctx();
  const res = await o.post(base + "/auth/signup", { data: { accept_legal: true, shop_name: "Perms Shop", name: "Pat Owner", email: email(), password: PASSWORD } });
  expect(res.status()).toBe(201);
  const w = await (await o.get(base + "/workspace")).json();
  const sid = (await (await o.post(base + "/staff", { data: { name: "Bo Barber", role: "Barber" } })).json()).id as string;
  void w;
  const bEmail = email();
  const inv = await o.post(base + "/auth/invites", { data: { staff_id: sid, email: bEmail, role: "BARBER" } });
  const barber = await ctx();
  const acc = await barber.post(base + "/auth/accept", { data: { email: bEmail, password: PASSWORD, name: "Bo Barber", token: (await inv.json()).token, accept_legal: true } });
  expect(acc.ok()).toBe(true);
  // No setup access by default.
  expect((await barber.post(base + "/services", { data: { name: "X cut", duration_min: 30, price_pence: 1000, category: "Hair" } })).status()).toBe(403);
  const members = (await (await o.get(base + "/auth/access")).json()).members as { id: string; role: string }[];
  const m = members.find((x) => x.role === "BARBER")!;
  const grant = await o.put(base + `/auth/members/${m.id}/permissions`, { data: { calendar: false, insights: true, pay: false, setup: true } });
  expect(grant.status(), await grant.text()).toBe(200);
  const add = await barber.post(base + "/services", { data: { name: "X cut", duration_min: 30, price_pence: 1000, category: "Hair" } });
  expect(add.status(), await add.text()).toBe(201);
  // Billing stays closed even with setup.
  expect((await barber.get(base + "/billing")).status()).toBe(403);
  // A barber cannot give themselves access.
  expect((await barber.put(base + `/auth/members/${m.id}/permissions`, { data: { calendar: true, insights: true, pay: true, setup: true } })).status()).toBe(403);
});
