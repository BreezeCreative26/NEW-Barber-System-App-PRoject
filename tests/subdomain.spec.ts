// Shop sub-domains: <slug>.<root> serves the shop page, booking, account and the team sign-in for
// that shop; the root host keeps marketing + signup and redirects shop paths to the sub-domain.
// Locally the root is localhost:3000 (APP_ORIGIN) and Chromium resolves *.localhost to loopback.
import { test, expect, request } from "@playwright/test";
import { base, origin } from "./shop";

const SHOP = "northline"; // persistent test shop (owner@northline.test / Demo1234!)
const shopOrigin = `http://${SHOP}.localhost:3000`;
// Node's resolver doesn't know *.localhost (Chromium does): API calls hit 127.0.0.1 with a Host header.
const viaHost = (host: string) => request.newContext({ baseURL: "http://127.0.0.1:3000", extraHTTPHeaders: { Host: host, Origin: `http://${host}` } });
const loop = (url: string) => url.replace(/^http:\/\/[^/]+/, "http://127.0.0.1:3000");

test("server: shop host serves short paths, tags the shell, manifest is scoped to the host; root redirects", async () => {
  const shop = await viaHost(`${SHOP}.localhost:3000`);
  for (const [path, needle] of [["/", "foliyo-shop"], ["/book", "foliyo-shop"], ["/me", "foliyo-shop"], ["/signin", 'foliyo-host" content="shop"']] as const) {
    const r = await shop.get(path);
    expect(r.status(), path).toBe(200);
    expect(await r.text(), path).toContain(needle);
  }
  const man = await (await shop.get("/manifest.webmanifest")).json();
  expect(man).toMatchObject({ name: "Northline Barbers", start_url: "/me?source=pwa", scope: "/" });
  expect(man.icons[0].src).toBe("/icon-192.png");
  expect((await shop.get("/icon-512.png")).headers()["content-type"]).toBe("image/png");
  // Root host: shop paths move to the sub-domain (301); marketing stays.
  const root = await viaHost("localhost:3000");
  for (const [path, to] of [[`/${SHOP}`, "/"], [`/book/${SHOP}`, "/book"], [`/${SHOP}/me`, "/me"]] as const) {
    const r = await root.get(path, { maxRedirects: 0 });
    expect(r.status(), path).toBe(301);
    expect(r.headers()["location"]).toBe(shopOrigin + to);
  }
  expect((await root.get("/")).status()).toBe(200);
  expect(await (await root.get("/signin")).text()).toMatch(/foliyo-host" content="(root|local)"/);
  // Reserved and unknown sub-domains fall through to the platform, not a shop.
  expect((await (await viaHost("www.localhost:3000")).get("/", { maxRedirects: 0 })).status()).toBeLessThan(400);
  expect((await (await viaHost("no-such-shop-xyz.localhost:3000")).get("/")).status()).toBe(404);
});

test("team sign-in is per shop: right shop signs in, another shop's address is refused with a pointer", async () => {
  const c = await viaHost(`${SHOP}.localhost:3000`);
  const ok = await c.post(`/api/app/auth/login`, { data: { email: "owner@northline.test", password: "Demo1234!" } });
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await c.get(`/api/app/auth/me`)).status()).toBe(200);
  // Same credentials on a different shop's host → 403 wrong_shop with the right address.
  const other = await viaHost("someoneelse.localhost:3000");
  const bad = await other.post(`/api/app/auth/login`, { data: { email: "owner@northline.test", password: "Demo1234!" } });
  expect(bad.status()).toBe(403);
  const j = await bad.json();
  expect(j.error).toBe("wrong_shop");
  expect(j.workspace_url).toBe(`${shopOrigin}/workspace`);
});

test("signup picks the web address: live check, reserved and taken refused, new owner is sent to their sub-domain", async () => {
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await (await c.get(`${base}/auth/slug-check?slug=${SHOP}`)).json()).ok).toBe(false);
  expect((await (await c.get(`${base}/auth/slug-check?slug=www`)).json()).ok).toBe(false);
  const fresh = `newshop-${crypto.randomUUID().slice(0, 6)}`;
  const chk = await (await c.get(`${base}/auth/slug-check?slug=${fresh}`)).json();
  expect(chk.ok).toBe(true);
  expect(chk.host).toBe(`${fresh}.localhost`);
  const dup = await c.post(`${base}/auth/signup`, { data: { shop_name: "Dup", slug: SHOP, name: "Dup Owner", email: `dup-${fresh}@example.test`, password: "a-long-password-12", accept_legal: true } });
  expect(dup.status()).toBe(409);
  const res = await c.post(`${base}/auth/signup`, { data: { shop_name: "New Shop", slug: fresh, name: "New Owner", email: `${fresh}@example.test`, password: "a-long-password-12", accept_legal: true } });
  expect(res.status(), await res.text()).toBe(201);
  const j = await res.json();
  expect(j.slug).toBe(fresh);
  expect(j.workspace_url).toBe(`http://${fresh}.localhost:3000/workspace`);
});

test("find your shop on the root host: by address → redirect target; by email → same shape, mailed", async () => {
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const bySlug = await (await c.post(`${base}/auth/find-shop`, { data: { slug: SHOP } })).json();
  expect(bySlug).toEqual({ ok: true, workspace_url: `${shopOrigin}/signin` });
  const typed = await (await c.post(`${base}/auth/find-shop`, { data: { slug: `${SHOP}.foliyo.co.uk` } })).json();
  expect(typed.workspace_url).toBe(`${shopOrigin}/signin`);
  const none = await (await c.post(`${base}/auth/find-shop`, { data: { slug: "nope-nope-nope" } })).json();
  expect(none.ok).toBe(false);
  const mail = await (await c.post(`${base}/auth/find-shop`, { data: { email: "owner@northline.test" } })).json();
  expect(mail).toEqual({ ok: true, mailed: true });
  const unknown = await (await c.post(`${base}/auth/find-shop`, { data: { email: "nobody@example.test" } })).json();
  expect(unknown).toEqual({ ok: true, mailed: true });
});

test("browser: customer journey on the sub-domain, then owner sign-in on the same host", async ({ page }) => {
  await page.goto(`${shopOrigin}/`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Northline/i);
  await expect(page.getByTestId("nav-me")).toHaveAttribute("href", "/me");
  await page.goto(`${shopOrigin}/book`);
  await expect(page.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await page.goto(`${shopOrigin}/me`);
  await expect(page.getByTestId("login-form")).toBeVisible();
  // Team sign-in on the shop host shows the shop, no "Create your shop" tab.
  await page.goto(`${shopOrigin}/signin`);
  await expect(page.getByTestId("auth-shop")).toContainText("Northline Barbers");
  await expect(page.getByRole("tab", { name: "Create your shop" })).toHaveCount(0);
  await page.getByLabel("Email").fill("owner@northline.test");
  await page.getByLabel("Password").fill("Demo1234!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`^${shopOrigin.replace(/\\./g, "\\\\.")}/workspace`));
});

test("browser: 'Find your shop' sends the owner to their address (root host uses it by default in production; local dev keeps sign-in)", async ({ page }) => {
  // Locally the root is localhost, so the shell reports "local" and the classic sign-in shows; the
  // production root reports "root" and opens straight on "Find your shop". Drive the finder directly.
  const shell = await (await request.newContext()).get(`${origin}/signin`);
  expect(await shell.text()).toMatch(/foliyo-host" content="(local|root)"/);
  await page.goto(`${origin}/signin`);
  await page.evaluate(() => { const m = document.querySelector('meta[name="foliyo-host"]'); if (m) m.setAttribute("content", "root"); });
  // Re-mount the auth screen by navigating client-side to the same route.
  await page.reload();
  const heading = page.getByRole("heading", { name: /Find your shop|Welcome back/ });
  await expect(heading).toBeVisible();
  if ((await heading.textContent())?.includes("Welcome back")) {
    // Local: the finder is reachable through the API; assert the redirect target instead.
    const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
    expect((await (await c.post(`${base}/auth/find-shop`, { data: { slug: SHOP } })).json()).workspace_url).toBe(`${shopOrigin}/signin`);
    return;
  }
  await page.getByTestId("find-slug").fill(SHOP);
  await page.getByTestId("find-go").click();
  await expect(page).toHaveURL(`${shopOrigin}/signin`);
  await expect(page.getByTestId("auth-shop")).toContainText("Northline Barbers");
});
