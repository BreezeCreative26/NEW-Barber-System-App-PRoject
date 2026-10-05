import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";

// Isolated browser contract tests: serve the actual built customer client, never call providers.
for (const ownHost of [false, true]) {
  test(`customer PWA logout rejects stale reads and retries failures (${ownHost ? "shop host" : "shared host"})`, async ({ page }) => {
    const manifest = JSON.parse(readFileSync("public/static/manifest.json", "utf8"));
    const entry = manifest["src/client/shop.tsx"].file;
    const scope = ownHost ? "/" : "/audit-shop/";
    const endpoint = "https://fcm.googleapis.com/fcm/send/device-audit";
    await page.addInitScript(({ scope, endpoint }) => {
      const state = { scopes: [] as string[], messages: [] as unknown[], unsubscribed: 0 };
      (window as any).pwaAudit = state;
      const sub = { endpoint, unsubscribe: async () => { state.unsubscribed++; return true; }, toJSON: () => ({ keys: { auth: "auth", p256dh: "key" } }) };
      const reg = { scope: location.origin + scope, active: { postMessage: (m: unknown) => state.messages.push(m) }, update: async () => {}, pushManager: { getSubscription: async () => sub } };
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
        register: async (_url: string, options: { scope: string }) => { state.scopes.push(options.scope); return reg; },
        getRegistration: async (path: string) => { state.scopes.push(path); return reg; },
        addEventListener: () => {},
        get ready() { throw new Error("Must not wait for another app's worker"); },
      } });
      Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
      Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "granted", requestPermission: async () => "granted" } });
    }, { scope, endpoint });
    const profile = { id: "customer", name: "Private Customer", phone: "07700900000", email: "customer@test.example", birthday: "", preferred_staff_id: "", marketing_opt_in: 0, notes: "", version: 0, member_since: 0, complete: true, has_password: true };
    const me = { shop: { name: "Audit Shop", slug: "audit-shop", address: "", timezone: "Europe/London", currency: "GBP", today: "2030-01-07", cancel_hours: 24, lead_time_min: 0 }, profile, upcoming: [], history: [], usual: null, next_usual: null, staff: [], stats: { visits: 0, spent_pence: 0, first_visit: null }, waiting: [] };
    let reads = 0, logouts = 0, pushWrites = 0, signedOut = false;
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("https://customer.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith("/static/")) {
        const file = resolve("public", path.slice(1));
        const types: Record<string,string> = { ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
        return route.fulfill({ status: existsSync(file) ? 200 : 404, contentType: types[extname(file)] || "application/octet-stream", body: existsSync(file) ? readFileSync(file) : "" });
      }
      if (path.endsWith("/account/session")) return route.fulfill({ json: { profile: signedOut ? null : profile } });
      if (path.endsWith("/account/me")) { reads++; if (reads === 2) await held; return route.fulfill({ json: me }); }
      if (path.endsWith("/account/logout")) {
        logouts++; expect(route.request().postDataJSON()).toEqual({ endpoint });
        if (logouts === 1) return route.fulfill({ status: 503, json: { message: "Sign out unavailable. Please retry." } });
        signedOut = true; return route.fulfill({ json: { ok: true } });
      }
      if (path.endsWith("/account/push")) {
        if (route.request().method() === "POST") { pushWrites++; return route.fulfill({ status: 503, json: { message: "Push setup unavailable. Please retry." } }); }
        return route.fulfill({ json: { enabled: true, public_key: "test", subscribed: false } });
      }
      if (path === "/api/public/shops/audit-shop") return route.fulfill({ json: { shop: me.shop } });
      if (path.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${ownHost ? '<meta name="foliyo-shop" content="audit-shop">' : ''}${["style", "design", "theme-fonts", "shop-theme"].map(n => `<link rel="stylesheet" href="/static/${n}.css">`).join("")}</head><body><div id="root"></div><script type="module" src="/static/${entry}"></script></body></html>` });
    });
    await page.goto(`https://customer.test${ownHost ? "/me" : "/audit-shop/me"}`);
    await expect(page.getByRole("heading", { name: "Hello, Private." })).toBeVisible();
    await page.getByTestId("push-toggle").click();
    await expect(page.getByTestId("app-card").getByRole("alert")).toContainText("Push setup unavailable");
    await expect(page.getByTestId("push-toggle")).toBeEnabled();
    expect(pushWrites).toBe(1);
    await page.getByTestId("sign-out").click();
    await expect(page.getByRole("alert").filter({ hasText: "Sign out unavailable" })).toBeVisible();
    await expect(page.getByTestId("customer-area")).toBeVisible();
    const pendingRead = page.waitForRequest(r => r.url().endsWith("/account/me"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await pendingRead;
    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("signin-email")).toBeVisible();
    const staleResponse = page.waitForResponse(r => r.url().endsWith("/account/me"));
    release(); await staleResponse;
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(page.getByTestId("customer-area")).toBeHidden();
    await expect(page.getByTestId("signin-email")).toBeVisible();
    const state = await page.evaluate(() => (window as any).pwaAudit);
    expect(state.unsubscribed).toBe(1);
    expect(state.messages).toEqual([{ type: "SIGNED_OUT" }]);
    expect(state.scopes.every((s: string) => s === scope || s === `https://customer.test${scope}`)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`registration verifies the phone and preserves inputs on failure (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const manifest = JSON.parse(readFileSync("public/static/manifest.json", "utf8"));
    const entry = manifest["src/client/shop.tsx"].file;
    let starts = 0, attempts = 0;
    const bodies: Record<string, unknown>[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://audit.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith("/static/")) {
        const file = resolve("public", path.slice(1));
        const types: Record<string, string> = { ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
        return route.fulfill({ status: existsSync(file) ? 200 : 404, contentType: types[extname(file)] || "application/octet-stream", body: existsSync(file) ? readFileSync(file) : "" });
      }
      if (path.endsWith("/account/session")) return route.fulfill({ json: { profile: null } });
      if (path.endsWith("/account/register/start")) {
        starts++;
        return route.fulfill({ status: 201, json: { ok: true } });
      }
      if (path.endsWith("/account/register")) {
        attempts++;
        bodies.push(route.request().postDataJSON());
        return route.fulfill({ status: 401, json: { error: "The verification code is invalid or expired" } });
      }
      if (path === "/api/public/shops/audit-shop") return route.fulfill({ json: { shop: { name: "Audit Shop", slug: "audit-shop", channels: { sms: true, email: true } } } });
      if (path.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${["style", "design", "theme-fonts", "shop-theme"].map(n => `<link rel="stylesheet" href="/static/${n}.css">`).join("")}</head><body><div id="root"></div><script type="module" src="/static/${entry}"></script></body></html>` });
    });
    await page.goto("http://audit.test/audit-shop/me");
    await page.getByTestId("signin-register").click();
    await page.getByTestId("register-name").fill("Test Customer");
    await page.getByTestId("register-phone").fill("07700900201");
    await page.getByTestId("register-email").fill("customer@example.test");
    await page.getByTestId("signin-password").fill("Example-password-123");
    await page.getByTestId("signin-password2").fill("Example-password-123");
    await page.getByTestId("register-submit").click();
    expect(starts).toBe(1);
    expect(attempts).toBe(0);
    await expect(page.getByTestId("register-code")).toBeVisible();
    await page.getByTestId("register-code").fill("123456");
    await page.getByTestId("register-code").press("Enter");
    await expect(page.getByRole("alert")).toContainText("invalid or expired");
    expect(bodies[0].code).toBe("123456");
    await expect(page.getByTestId("register-email")).toHaveValue("customer@example.test");
    await expect(page.getByTestId("signin-password")).toHaveValue("Example-password-123");
    await page.getByTestId("register-phone").fill("07700900202");
    await expect(page.getByTestId("register-code")).toBeHidden();
    await page.getByTestId("register-submit").click();
    expect(starts).toBe(2);
    expect(attempts).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`registration-${width}.png`), fullPage: true });
  });
}


for (const role of ["FINANCE", "SUPPORT"]) {
  test(`Foliyo fee controls: ${role} permissions and safe retry`, async ({ page }) => {
    const manifest = JSON.parse(readFileSync("public/static/manifest.json", "utf8"));
    const entry = manifest["src/client/main.tsx"].file;
    const shop = { id: "11111111-1111-4111-8111-111111111111", name: "Test Shop", slug: "test-shop", fee_bps: null, fixed_pence: null, use_default: null, version: 0, effective_bps: 150, effective_fixed_pence: 0 };
    const defaults = { scope: "default", shop_id: null, fee_bps: 150, fixed_pence: 0, use_default: 0, version: 1, updated_at: 0 };
    const saves: any[] = [], credits: any[] = [], errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.route("https://fees.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith("/static/")) {
        const file = resolve("public", path.slice(1));
        const types: Record<string, string> = { ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
        return route.fulfill({ status: existsSync(file) ? 200 : 404, contentType: types[extname(file)] || "application/octet-stream", body: existsSync(file) ? readFileSync(file) : "" });
      }
      if (path === "/api/admin/me") return route.fulfill({ json: { admin: { name: "Fee Admin", email: "admin@test.example", role } } });
      if (path === "/api/admin/fees") return route.fulfill({ json: { defaults, shops: [shop] } });
      if (path === "/api/admin/fees/default" && route.request().method() === "PUT") {
        saves.push(route.request().postDataJSON());
        if (saves.length === 1) return route.fulfill({ status: 409, json: { message: "Fees changed. Refresh before saving." } });
        defaults.version++;
        return route.fulfill({ json: { rule: defaults } });
      }
      if (path.endsWith("/statement")) return route.fulfill({ json: { from: "2026-10-01", to: "2026-10-04", currency: "GBP", charges: [{ payment_intent: "pi_test", booking_id: "booking-test", fee_pence: 60, gross_pence: 3000, credited_pence: 0, created_at: Date.now() }], totals: { fee_pence: 60, gross_pence: 3000, credited_pence: 0, count: 1 }, truncated: false } });
      if (path.endsWith("/credits")) {
        credits.push(route.request().postDataJSON());
        if (credits.length === 1) return route.fulfill({ status: 503, json: { message: "Temporary failure; retry the same correction" } });
        return route.fulfill({ status: 201, json: { adjustment_id: "credit-test" } });
      }
      if (path.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${["style", "design"].map(n => `<link rel="stylesheet" href="/static/${n}.css">`).join("")}</head><body><div id="root"></div><script type="module" src="/static/${entry}"></script></body></html>` });
    });
    await page.goto("https://fees.test/admin/fees");
    await expect(page.getByRole("heading", { name: "Foliyo payment fees" })).toBeVisible();
    if (role === "SUPPORT") {
      await expect(page.getByLabel("Percentage (%)")).toBeDisabled();
      await expect(page.getByRole("button", { name: "Save fee policy" })).toBeDisabled();
      expect(saves).toHaveLength(0);
    } else {
      await expect(page.getByRole("button", { name: "Save fee policy" })).toBeDisabled();
      await page.getByLabel("Percentage (%)").fill("2.50");
      await page.getByLabel("Fixed charge (GBP)").fill("0.20");
      await page.getByLabel("Internal reason", { exact: true }).fill("Agreed revised business fees");
      await page.getByLabel("The affected shops have agreed").check();
      await page.getByRole("button", { name: "Save fee policy" }).click();
      await expect(page.getByText("Fees changed. Refresh before saving.", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Percentage (%)")).toHaveValue("2.50");
      expect(saves[0]).toMatchObject({ fee_bps: 250, fixed_pence: 20, notice_confirmed: true, version: 1 });
      await page.getByRole("button", { name: "Save fee policy" }).click();
      await expect(page.getByText("Fee policy saved. Existing quotes and charges were not changed.")).toBeVisible();
      await page.getByLabel("Pricing scope").selectOption(shop.id);
      await expect(page.getByLabel("Use the platform default")).toBeChecked();
      await page.getByRole("button", { name: "Load fees" }).click();
      await page.getByRole("button", { name: "Credit fee", exact: true }).click();
      await page.getByLabel("Credit amount (GBP)").fill("0.30");
      await page.getByLabel("Internal reason", { exact: true }).last().fill("Goodwill fee correction");
      await page.getByRole("button", { name: "Create account credit" }).click();
      await expect(page.getByText("Temporary failure; retry the same correction", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Create account credit" }).click();
      await expect(page.getByText("Account credit created against Foliyo billing. No customer card refund or wallet cash was issued.")).toBeVisible();
      expect(credits).toHaveLength(2); expect(credits[0]).toEqual(credits[1]);
      expect(credits[0].amount_pence).toBe(30);
    }
    expect(errors).toEqual([]);
  });
}
