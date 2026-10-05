import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";

// Isolated browser contract tests: serve the actual built customer client, never call providers.
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
