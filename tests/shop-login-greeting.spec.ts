// A business "shop login" is named after the shop, so emails to it must not greet a made-up first
// name ("Welcome, The."). Individuals are still greeted by name. WhatsApp (retired) starts off.
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
const DB = execSync("grep ^DATABASE_URL .env | cut -d= -f2-", { cwd: "/home/user/webapp" }).toString().trim();
const heading = (id: string) => execSync(`psql "${DB}" -Atc "select html from notifications where id='${id}'"`).toString();
const origin = "http://localhost:3000";
const base = origin + "/api/app";

async function signup(page: import("@playwright/test").Page, business: boolean) {
  const email = `greet-${business ? "b" : "i"}-${Date.now()}@example.com`;
  const res = await page.request.post(base + "/auth/signup", {
    headers: { Origin: origin },
    data: { shop_name: "The Greeting Barbers", account_type: business ? "BUSINESS" : "INDIVIDUAL", shop_login: business, ...(business ? {} : { name: "Vera Owner" }), email, password: "Passw0rd!passw0rd", accept_legal: true, kind: "BARBER" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const box = await (await page.request.get(base + "/notifications")).json();
  return box.notifications.find((n: { template: string }) => n.template === "owner_welcome");
}

test("shop login welcome email has no invented first name; an individual is greeted by name", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const biz = await signup(a, true);
  expect(biz, "welcome queued").toBeTruthy();
  expect(biz.body).not.toMatch(/Welcome, The\b/);
  expect(heading(biz.id)).toMatch(/>\s*Welcome\.\s*</);
  expect(heading(biz.id)).not.toMatch(/Welcome, The/);
  const w = await (await a.request.get(base + "/workspace")).json();
  expect(w.shop.msg_wa ?? 0).toBe(0);

  const b = await (await browser.newContext()).newPage();
  const ind = await signup(b, false);
  expect(heading(ind.id)).toMatch(/Welcome, Vera\./);
});
