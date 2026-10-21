import { test, expect, request } from "@playwright/test";
import { base, newShop, origin, PASSWORD } from "./shop";

test("the owner signs in on the shop's customer sign-in and is taken to the admin side; strangers are refused", async () => {
  const { r, email } = await newShop("Team Signin Shop");
  const w = await (await r.get(base + "/workspace")).json();
  const slug = `ts-${crypto.randomUUID().slice(0, 8)}`;
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
  const url = `${origin}/api/public/shops/${slug}/account/login`;
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const ok = await c.post(url, { data: { email, password: PASSWORD } });
  expect(ok.status()).toBe(201);
  expect(await ok.json()).toMatchObject({ team: true, workspace_url: "/workspace" });
  expect((await c.get(base + "/workspace")).status()).toBe(200);
  const bad = await (await request.newContext({ extraHTTPHeaders: { Origin: origin } })).post(url, { data: { email, password: "Wrong-pass-1" } });
  expect(bad.status()).toBe(401);
  // Same email again at signup: refused, without revealing the shop address.
  const again = await (await request.newContext({ extraHTTPHeaders: { Origin: origin } })).post(base + "/auth/signup", { data: { shop_name: "Second", name: "Second Owner", email, password: PASSWORD, accept_legal: true } });
  expect(again.status()).toBe(409);
  expect(await again.text()).not.toContain(slug);
});
