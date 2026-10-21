// A shop can switch customer text-code sign-in off. Off means: no button, and the server refuses
// codes (start and verify). Texts being off turns it off too. Email + password always work.
import { test, expect, request } from "@playwright/test";
import { base, newShop, origin, enterNewShop } from "./shop";
import { section } from "./fixture";

const pub = origin + "/api/public";
const phone = () => `07700${String(Math.floor(100000 + Math.random() * 899999))}`;
async function shopWith() {
  const { r } = await newShop("Code Setting Shop");
  const w = await (await r.get(base + "/workspace")).json();
  const slug = `cs-${crypto.randomUUID().slice(0, 8)}`;
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);
  return { r, slug };
}
const setMsg = async (r: Awaited<ReturnType<typeof shopWith>>["r"], over: Record<string, number>) => {
  const cur = (await (await r.get(base + "/notifications")).json()).messaging;
  const res = await r.put(base + "/shop/messaging", { data: { ...cur, sms_billing_ack: true, ...over } });
  expect(res.status(), await res.text()).toBe(200);
};
const channels = async (slug: string) => (await (await (await request.newContext()).get(`${pub}/shops/${slug}`)).json()).shop.channels;

test("code sign-in is on by default, off when the shop switches it off, and off when texts are off", async () => {
  const { r, slug } = await shopWith();
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const A = `${pub}/shops/${slug}/account`;
  expect((await channels(slug)).code).toBe(true);
  expect((await c.post(`${A}/start`, { data: { phone: phone() } })).status()).toBe(201);

  await setMsg(r, { customer_code_signin: 0 });
  expect((await channels(slug)).code).toBe(false);
  expect((await channels(slug)).sms).toBe(true); // texts still on for confirmations
  const start = await c.post(`${A}/start`, { data: { phone: phone() } });
  expect(start.status()).toBe(409);
  expect(await start.text()).toContain("code_signin_off");
  expect((await c.post(`${A}/verify`, { data: { phone: phone(), code: "123456" } })).status()).toBe(409);

  // Email and password still work.
  const p = { name: "Pass Word", phone: phone(), email: `pw-${crypto.randomUUID().slice(0, 8)}@example.test` };
  expect((await c.post(`${A}/register`, { data: { ...p, password: "Fictional-pass-2026!" } })).status()).toBe(201);
  const c2 = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await c2.post(`${A}/login`, { data: { email: p.email, password: "Fictional-pass-2026!" } })).status()).toBeLessThan(300);

  // Back on: works again. Texts off: code is off whatever the switch says.
  await setMsg(r, { customer_code_signin: 1 });
  expect((await channels(slug)).code).toBe(true);
  await setMsg(r, { customer_code_signin: 1, msg_sms: 0 });
  expect((await channels(slug)).code).toBe(false);
  expect((await c.post(`${A}/start`, { data: { phone: phone() } })).status()).toBe(409);
});

test("browser: the owner's switch hides the 'Text me a code' button on the customer sign-in", async ({ page, browser }) => {
  const { r, slug } = await shopWith();
  const host = { "x-forwarded-host": `${slug}.localhost:3000` };
  const open = async () => {
    const ctx = await browser.newContext({ extraHTTPHeaders: host });
    const pg = await ctx.newPage();
    await pg.goto(origin + "/me");
    return { ctx, pg };
  };
  let v = await open();
  await expect(v.pg.getByTestId("signin-use-code")).toBeVisible();
  await v.ctx.close();
  await setMsg(r, { customer_code_signin: 0 });
  v = await open();
  await expect(v.pg.getByRole("button", { name: /sign in|log in/i }).first()).toBeVisible();
  await expect(v.pg.getByTestId("signin-use-code")).toHaveCount(0);
  await v.ctx.close();
});

test("browser: the owner finds the switch in Settings, Messages, and it saves", async ({ page }) => {
  await enterNewShop(page, "Code switch UI shop");
  await section(page, "Settings/messages");
  const form = page.getByTestId("messaging-form");
  const sw = form.getByTestId("msg-code-signin");
  await expect(form.getByTestId("chan-code-signin")).toBeVisible();
  await expect(sw).toBeChecked();
  await sw.evaluate((el) => (el as HTMLInputElement).click());
  await expect(sw).not.toBeChecked();
  const ack = form.getByTestId("msg-sms-billing-ack");
  if (await ack.count()) await ack.locator("input").check();
  await form.getByTestId("save-messaging").click();
  await expect.poll(async () => (await (await page.request.get(base + "/notifications")).json()).messaging.customer_code_signin).toBe(0);
  await page.reload();
  await section(page, "Settings/messages");
  await expect(page.getByTestId("msg-code-signin")).not.toBeChecked();
  await page.getByTestId("chan-code-signin").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/code-switch.png" });
});
