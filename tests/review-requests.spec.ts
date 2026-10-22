import { test, expect } from "@playwright/test";
import { newShop } from "./shop";

const base = "http://localhost:3000/api/app";
test("review requests: email on by default, text needs the price accepted and texts on", async () => {
  const { r } = await newShop("Review ask shop");
  const w = await (await r.get(base + "/workspace")).json();
  expect(w.shop.review_ask_email).toBe(1);
  expect(w.shop.review_ask_sms).toBe(0);
  // Turning on review texts without accepting the 8p price is refused; with it, it works.
  const refused = await r.put(base + "/shop/reviews", { data: { google_review_nudge: 0, review_ask_sms: 1, version: w.shop.version } });
  expect(refused.status()).toBe(409);
  const ok = await r.put(base + "/shop/reviews", { data: { google_review_nudge: 0, review_ask_sms: 1, sms_billing_ack: true, version: w.shop.version } });
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await ok.json()).shop.review_ask_sms).toBe(1);
  // The reviews list answers with a per-barber breakdown.
  const list = await (await r.get(base + "/reviews")).json();
  expect(Array.isArray(list.by_staff)).toBe(true);
  expect(list.scope).toBe("all");
});
