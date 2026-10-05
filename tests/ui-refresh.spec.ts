import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { landingPage, VERTICALS } from "../src/server/landing";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { selectSettingsTab } from "./fixture";

// Isolated visual/interaction fixtures: no production DB, customers, messages or payments.
const today = "2030-01-07";
const now = Date.parse(today + "T10:00:00Z");
const staff = ["Jay Carter", "Marcus Reed", "Dani Okoro"].map((name, i) => ({ id: `staff-${i}`, shop_id: "shop", name, role: "BARBER", active: 1, online_visible: 1, version: 0, colour: ["sage", "blue", "plum"][i], commission_pct: 50, pay_model: "COMMISSION", pay_period: "WEEKLY", tip_share_pct: 100, commission_tiers: "[]", deductions_json: "[]", skills: "[]", photo_url: "", bio: "", title: "Barber", sort_order: i }));
const services = [{ id: "cut", shop_id: "shop", name: "Signature cut", duration_min: 30, price_pence: 2800, category: "Hair", active: 1, online_bookable: 1, colour: "sage", version: 0, popular: 0, sort_order: 0, payment_mode: null, description: "A clean finish, tailored to you." }];
const bookings = ["Alex Morgan", "Jordan Lee", "Sam Taylor", "Riley Chen", "Casey James", "Jamie Wilson"].map((name, i) => ({ id: `booking-${i}`, shop_id: "shop", sequence: i + 1, request_id: `request-${i}`, request_hash: "test", staff_id: staff[i % 3].id, service_id: "cut", service_name: "Signature cut", customer_name: name, phone: "07700900000", email: "test@example.test", notes: "", date: today, start_min: 570 + Math.floor(i / 3) * 75, start_at: Date.parse(today + "T00:00:00Z") + (570 + Math.floor(i / 3) * 75) * 60000, end_at: Date.parse(today + "T00:00:00Z") + (600 + Math.floor(i / 3) * 75) * 60000, duration_min: 30, buffer_min: 10, price_pence: 2800, deposit_policy_pence: 0, cancel_hours_snapshot: 24, source: "TEST_BOOKING", channel: i % 2 ? "OWNER" : "ONLINE", status: i === 0 ? "COMPLETED" : "CONFIRMED", version: 0, customer_id: `customer-${i}`, deposit_status: "NONE", payment_mode: "PAY_AT_VISIT", created_at: now, updated_at: now, items_json: JSON.stringify([{ kind: "SERVICE", ...services[0] }]) }));
const workspace = {
  shop: { id: "shop", name: "Northline Barbers", slug: "northline", address: "12 High Street", timezone: "Europe/London", currency: "GBP", opens: 540, closes: 1080, closed_days: "[]", week_json: JSON.stringify(Array.from({ length: 7 }, () => ({ enabled: 1, starts: 540, ends: 1080 }))), deposit_pence: 0, cancel_hours: 24, no_show_grace: 15, version: 0, buffer_min: 10, online_booking: 1, card_colour: "BARBER", calendar_density: "STANDARD", till_access: "OWNER", setup_json: '{"dismissed":true}', pay_show_owner_share: 1 },
  account: { id: "member", user_id: "owner", name: "Taylor Owner", email: "owner@example.test", role: "OWNER", shop_id: "shop", staff_id: null, email_verified_at: now, prefs_json: "{}" },
  staff, services, bookings, payments: [], hours: staff.flatMap(s => Array.from({ length: 7 }, (_, weekday) => ({ shop_id: "shop", staff_id: s.id, weekday, enabled: 1, starts: 540, ends: 1080, break_start: 780, break_end: 810 }))),
  holidays: [], audit: [], issues: [], days_off: [], blocks: [], addons: [], addon_links: [], service_rules: [], schedule_overrides: [], today, now, mode: "sandbox", entitlements: null, logo_url: "", logo_tone: "",
};

async function mountWorkspace(page: Page) {
  const errors: string[] = [], mutations: { path: string; body: any }[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.clock.install({ time: new Date(now) });
  const manifest = JSON.parse(readFileSync("public/static/manifest.json", "utf8"));
  await page.route("https://ui.test/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.startsWith("/static/")) {
      const file = resolve("public", path.slice(1));
      if (!file.startsWith(resolve("public") + "/")) return route.fulfill({ status: 404 });
      const types: Record<string, string> = { ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
      return route.fulfill({ status: existsSync(file) ? 200 : 404, contentType: types[extname(file)] || "application/octet-stream", body: existsSync(file) ? readFileSync(file) : "" });
    }
    if (path.startsWith("/api/")) {
      const api = path.replace(/^\/api\/(app|sandbox)/, "");
      if (route.request().method() !== "GET") {
        const body = route.request().postDataJSON(); mutations.push({ path: api, body });
        if (api.endsWith("/reschedule")) {
          const b = bookings.find(b => api.includes(b.id))!;
          return route.fulfill({ json: { booking: { ...b, start_min: body.start_min, staff_id: body.staff_id, version: b.version + 1 } } });
        }
        return route.fulfill({ json: { ok: true } });
      }
      if (api === "/workspace") return route.fulfill({ json: workspace });
      if (api === "/bookings") return route.fulfill({ json: { bookings: url.searchParams.get("date") === today ? bookings : [], next_cursor: null } });
      if (api === "/bookings/range") return route.fulfill({ json: { bookings } });
      if (api === "/changes") return route.fulfill({ json: { cursor: "stable" } });
      if (api === "/waitlist") return route.fulfill({ json: { waitlist: [], counts: {} } });
      if (api === "/customers") return route.fulfill({ json: { customers: [], total: 0 } });
      if (api.endsWith("/timeline")) return route.fulfill({ json: { booking: bookings.find(b => api.includes(b.id)), events: [], customer: null, series: [] } });
      if (api === "/auth/access") return route.fulfill({ json: { members: [], invitations: [] } });
      if (api === "/auth/me") return route.fulfill({ json: { account: workspace.account, demo: false } });
      if (api === "/availability") return route.fulfill({ json: { slots: [600, 630, 660].map(start_min => ({ start_min, reason: "" })), items: [{ kind: "SERVICE", ...services[0] }], overridden: false, service_name: "Signature cut", cancel_hours: 24, price_pence: 2800, duration_min: 30, deposit_policy_pence: 0, quote: { service_version: 0, shop_version: 0 } } });
      if (api === "/pay-runs/period") return route.fulfill({ json: { rows: staff.map(s => ({ staff_id: s.id, name: s.name, pay_model: "COMMISSION", existing: null, sales_pence: 5600, tips_pence: 0, visits: 2, owed_to_staff_pence: 2800, owed_to_business_pence: 2800, deductions_pence: 0, has_activity: true })) } });
      if (api === "/wallets") return route.fulfill({ json: { from: today, to: today, stripe: { live: false, connect: true }, rows: [], shop: null, totals: { earned_pence: 0, awaiting_approval_pence: 0, transferred_pence: 0, settled_by_hand_pence: 0, paid_out_pence: 0, in_transit_pence: 0, in_wallets_pence: 0 } } });
      if (api === "/pay-runs") return route.fulfill({ json: { pay_runs: [] } });
      if (/^\/bookings\/[^/]+$/.test(api)) return route.fulfill({ json: { booking: bookings.find(b => api.includes(b.id)) } });
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${["style", "design", "theme-fonts", "shop-theme"].map(n => `<link rel="stylesheet" href="/static/${n}.css">`).join("")}</head><body><div id="root"></div><script type="module" src="/static/${manifest["src/client/main.tsx"].file}"></script></body></html>` });
  });
  await page.goto("https://ui.test/workspace");
  await expect(page.locator(".calendar-board")).toBeVisible();
  return { errors, mutations };
}

for (const width of [390, 768, 1024, 1280, 1440]) {
  test(`calendar refresh: layout, navigation and date keyboard (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 960 });
    const { errors, mutations } = await mountWorkspace(page);
    await expect(page.getByTestId("calendar-summary")).toContainText("6 matching", { useInnerText: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const calendarAxe = await new AxeBuilder({ page }).include("#workspace-main").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(calendarAxe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.screenshot({ path: info.outputPath(`calendar-${width}.png`), fullPage: true });
    const trigger = page.getByRole("button", { name: /^Choose appointment date,/ });
    await trigger.click();
    const picker = page.getByRole("dialog", { name: "Choose appointment date" });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("button", { name: "Monday, 7 January 2030", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(picker.getByRole("button", { name: "Tuesday, 8 January 2030", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("8 Jan 2030");
    await trigger.click(); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    await page.getByRole("button", { name: "Today", exact: true }).first().click();
    await expect(trigger).toContainText("7 Jan 2030");
    await trigger.click();
    const axe = await new AxeBuilder({ page }).include(".calendar-date-dialog").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.screenshot({ path: info.outputPath(`datepicker-${width}.png`) });
    await picker.getByRole("button", { name: "Next month" }).click(); await expect(picker.getByText("February 2030", { exact: true })).toBeVisible();
    await picker.getByLabel("Appointment date", { exact: true }).fill("2030-01-07");
    await picker.getByRole("button", { name: "Go", exact: true }).click();
    await page.getByRole("button", { name: "Agenda", exact: true }).click();
    await expect(page.locator(".calendar-board")).not.toBeVisible();
    await page.getByRole("button", { name: "Day timetable", exact: true }).click();
    await expect(page.locator(".calendar-board")).toBeVisible();
    await page.getByTestId("filters-toggle").click();
    await expect(page.getByLabel("Search appointments")).toBeVisible();
    await expect(page.locator(".calendar-staff-header")).toContainText("£56 booked · 2 visits");
    const valueBefore = await page.locator(".calendar-staff-header").innerText();
    await page.getByLabel("Search appointments").fill("Jordan");
    await expect(page.locator(".calendar-event")).toHaveCount(1);
    expect(await page.locator(".calendar-staff-header").innerText()).toBe(valueBefore);
    await page.getByLabel("Search appointments").fill("");
    expect(mutations).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}


for (const width of [390, 1440]) {
  test(`workspace screen audit (${width}px)`, async ({ page }, info) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 960 });
    const { errors } = await mountWorkspace(page);
    const findings: unknown[] = [];
    for (const name of ["Services", "Team", "Shifts", "Pay runs", "Settings", "Accounts", "Audit"]) {
      if (width < 768) await page.locator(".topbar-menu").click();
      await page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
      await expect(page.locator(".workspace-heading h1")).toBeVisible();
      if (name === "Pay runs") await expect(page.getByTestId("pay-runs-table")).toBeVisible();
      expect(errors, name).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
      await page.screenshot({ path: info.outputPath(`${name.replaceAll(" ", "-").toLowerCase()}-${width}.png`), fullPage: true });
      const result = await new AxeBuilder({ page }).include("#workspace-main").withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), name).toEqual([]);
      findings.push({ screen: name, violations: result.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, targets: v.nodes.map(n => n.target) })) });
    }
    await info.attach("screen-accessibility-findings", { body: JSON.stringify(findings, null, 2), contentType: "application/json" });
    expect(errors).toEqual([]);
  });
}

test("calendar gestures retain move, resize and undo request contracts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const { mutations, errors } = await mountWorkspace(page);
  page.on("dialog", d => d.accept());
  const event = page.locator('.calendar-event').filter({ hasText: "Riley Chen" });
  await event.scrollIntoViewIfNeeded();
  const box = (await event.boundingBox())!;
  await page.mouse.move(box.x + 45, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 45, box.y + 72, { steps: 8 });
  await expect(page.getByTestId("drop-ghost")).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => mutations.some(m => m.path.endsWith("/reschedule"))).toBe(true);
  const move = mutations.find(m => m.path.endsWith("/reschedule"))!;
  expect(move.body.version).toBe(0); expect(move.body.start_min % 15).toBe(0);
  await expect(page.getByTestId("undo")).toBeVisible();
  await page.getByTestId("undo").click();
  await expect.poll(() => mutations.filter(m => m.path.endsWith("/reschedule")).length).toBe(2);
  const handle = event.getByTestId("resize-handle");
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down(); await page.mouse.move(h.x + h.width / 2, h.y + 65, { steps: 8 });
  await expect(page.getByTestId("resize-label")).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => mutations.some(m => m.path.endsWith("/items"))).toBe(true);
  const resize = mutations.find(m => m.path.endsWith("/items"))!;
  expect(resize.body.service_price_pence).toBe(2800); expect(resize.body.service_duration_min).toBeGreaterThan(30);
  expect(errors).toEqual([]);
});


for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 844, height: 390 }, { width: 1366, height: 768 }]) {
  test(`uncluttered calendar and options (${viewport.width}x${viewport.height})`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const { errors, mutations } = await mountWorkspace(page);
    const landscape = viewport.height < 500;
    const toolbar = await page.locator(".calendar-toolbar-row").boundingBox();
    expect(toolbar!.height).toBeLessThanOrEqual(landscape ? 64 : viewport.width < 768 ? 118 : 76);
    const board = await page.locator(".connected-scroll").boundingBox();
    expect(board!.height).toBeGreaterThanOrEqual(180);
    expect(board!.y + board!.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const controls = await page.locator('.calendar-toolbar-row button:visible').evaluateAll(els => els.map(el => {
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    }));
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j];
      expect(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1, "Toolbar buttons must not overlap").toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`clean-calendar-${viewport.width}x${viewport.height}.png`) });
    const trigger = page.getByRole("button", { name: /^Choose appointment date,/ });
    await trigger.click();
    const picker = page.getByRole("dialog", { name: "Choose appointment date" });
    await page.keyboard.press("ArrowUp");
    await expect(picker.getByRole("button", { name: "Monday, 31 December 2029", exact: true })).toBeFocused();
    await picker.getByLabel("Appointment date", { exact: true }).fill("2032-02-29");
    await picker.getByRole("button", { name: "Go", exact: true }).click();
    await expect(trigger).toContainText("29 Feb 2032");
    await trigger.click();
    if (landscape) {
      await expect(picker.getByRole("button", { name: "Next month" })).toBeInViewport();
      await expect(picker.getByRole("button", { name: "Jump to today" })).toBeInViewport();
    }
    await page.screenshot({ path: info.outputPath(`clean-datepicker-${viewport.width}x${viewport.height}.png`) });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.getByRole("button", { name: "Today", exact: true }).first().click();
    await expect(page.getByLabel("Barber filter")).toBeHidden();
    await page.getByTestId("filters-toggle").click();
    await expect(page.getByLabel("Barber filter")).toBeVisible();
    await expect(page.getByTestId("walk-in")).toBeEnabled();
    await page.getByTestId("team-picker").click();
    await expect(page.getByRole("dialog", { name: "Scheduled team" })).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByLabel("Barber filter").selectOption("staff-1");
    await expect(page.locator(".calendar-event")).toHaveCount(2);
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(page.locator(".calendar-event")).toHaveCount(6);
    const optionsAxe = await new AxeBuilder({ page }).include("#timetable-filters").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(optionsAxe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.getByTestId("close-calendar-options").click();
    await expect(page.getByTestId("filters-toggle")).toBeFocused();
    await page.getByTestId("density-button").click();
    await page.getByTestId("density-compact").click();
    await expect(page.locator(".connected-scroll")).toHaveAttribute("data-density", "COMPACT");
    await page.getByRole("button", { name: "New booking", exact: true }).click();
    await expect(page.getByRole("dialog").last()).toBeVisible();
    const formAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(formAxe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.screenshot({ path: info.outputPath(`clean-booking-form-${viewport.width}x${viewport.height}.png`) });
    expect(mutations.map(m => m.path)).toEqual(["/me/prefs"]);
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`Foliyo homepage palette and contrast (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("https://brand.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith("/static/")) {
        const file = resolve("public", path.slice(1));
        if (!file.startsWith(resolve("public") + "/") || !existsSync(file)) return route.fulfill({ status: 404 });
        const types: Record<string, string> = { ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg" };
        return route.fulfill({ contentType: types[extname(file)] || "application/octet-stream", body: readFileSync(file) });
      }
      return route.fulfill({ contentType: "text/html", body: landingPage("https://brand.test", VERTICALS.universal) });
    });
    await page.goto("https://brand.test/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await expect(page.locator(".l-light").first()).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator(".l-btn-green").first()).toHaveCSS("background-color", "rgb(0, 232, 176)");
    await page.screenshot({ path: info.outputPath(`clean-homepage-${width}.png`), fullPage: true });
  });
}


async function openOwnerSection(page: Page, name: string) {
  if ((page.viewportSize()?.width || 1440) < 768) await page.locator(".topbar-menu").click();
  await page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
}

for (const width of [390, 768, 1440]) {
  test(`owner admin: settings navigation, deep links and forms (${width}px)`, async ({ page }, info) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    const { errors } = await mountWorkspace(page);
    await page.goto("https://ui.test/workspace#settings/calendar");
    await page.reload();
    await expect(page.getByTestId("workspace-look")).toBeVisible();
    await expect(page).toHaveURL(/#settings\/calendar$/);
    if (width < 981) {
      await expect(page.getByTestId("settings-section-select")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeHidden();
    } else {
      await page.getByTestId("settings-tab-calendar").focus();
      await page.keyboard.press("Home");
      await expect(page.getByTestId("settings-tab-general")).toBeFocused();
      await expect(page.getByTestId("biz-name")).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByTestId("settings-tab-hours")).toBeFocused();
    }
    for (const key of ["general", "hours", "calendar", "booking", "page", "security", "audit"]) {
      await selectSettingsTab(page, key);
      await expect(page.getByRole("tabpanel")).toHaveAttribute("id", `settings-${key}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), key).toBe(true);
      if (key === "general") {
        expect((await page.getByTestId("biz-name").boundingBox())!.y).toBeLessThan(520);
      }
      const axe = await new AxeBuilder({ page }).include("#workspace-main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), key).toEqual([]);
      await page.screenshot({ path: info.outputPath(`owner-settings-${key}-${width}.png`), fullPage: true });
    }
    await selectSettingsTab(page, "general");
    await page.getByTestId("biz-name").fill("Unsaved shop name");
    page.once("dialog", dialog => dialog.dismiss());
    await selectSettingsTab(page, "hours");
    await expect(page.getByTestId("biz-name")).toHaveValue("Unsaved shop name");
    await expect(page).toHaveURL(/#settings\/general$/);
    if (width < 981) await expect(page.getByTestId("settings-section-select")).toHaveValue("general");
    await page.route("**/api/app/setup/contact", route => route.fulfill({ status: 503, json: { message: "Business save unavailable" } }));
    await page.getByRole("button", { name: "Save business details", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Business save unavailable");
    await expect(page.getByTestId("biz-name")).toHaveValue("Unsaved shop name");
    expect(errors).toEqual([]);
  });
}

for (const config of [
  { section: "Services", card: "service-card", editor: "service-editor", label: "Service name", save: "Save service", add: "New service", path: "/services/cut", collection: "services", success: "Service saved" },
  { section: "Team", card: "team-card", editor: "barber-editor", label: "Full name", save: "Save profile", add: "Add barber", path: "/staff/staff-0", collection: "staff", success: "Profile saved" },
] as const) {
  test(`owner admin: ${config.section} protects edits, pending saves and safe retry`, async ({ page }, info) => {
    const { errors } = await mountWorkspace(page);
    await openOwnerSection(page, config.section);
    await page.getByTestId(config.card).first().click();
    const editor = page.getByTestId(config.editor);
    const name = editor.getByLabel(config.label, { exact: true });
    await expect(editor.getByRole("button", { name: config.save, exact: true })).toBeDisabled();
    await name.fill("Edited but not lost");
    await page.getByRole("button", { name: config.add, exact: true }).click();
    await expect(page.getByText("You have unsaved changes in this section.", { exact: true })).toBeVisible();
    await expect(name).toHaveValue("Edited but not lost");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    const updated = structuredClone(workspace);
    let attempts = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/app${config.path}`, async route => {
      attempts++;
      if (attempts === 1) {
        await pending;
        return route.fulfill({ status: 503, json: { message: "Isolated save failure" } });
      }
      const body = route.request().postDataJSON();
      expect(body.version).toBe(0);
      Object.assign(updated[config.collection][0], body, { version: 1 });
      if (config.collection === "staff") Object.assign(updated.staff[0], {
        skills: JSON.stringify(body.skills), commission_tiers: JSON.stringify(body.commission_tiers), deductions_json: JSON.stringify(body.deductions),
      });
      return route.fulfill({ json: { id: updated[config.collection][0].id } });
    });
    await page.route("**/api/app/workspace", route => route.fulfill({ json: updated }));
    await editor.getByRole("button", { name: config.save, exact: true }).click();
    await expect(name).toBeDisabled();
    await expect(editor.locator("form").first()).toHaveAttribute("aria-busy", "true");
    await editor.locator("form").first().evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await page.getByRole("button", { name: config.add, exact: true }).click();
    await expect(page.getByText("A save is in progress. Wait for its result before leaving this section.", { exact: true })).toBeVisible();
    expect(attempts).toBe(1);
    await openOwnerSection(page, "Settings");
    await expect(editor).toBeVisible();
    await expect(page.getByText("Wait for the current save before changing screens.", { exact: true })).toBeVisible();
    release();
    await expect(editor.getByRole("alert")).toContainText("Isolated save failure");
    await expect(name).toBeEnabled();
    await expect(name).toHaveValue("Edited but not lost");
    await expect(page.getByText("A save is in progress. Wait for its result before leaving this section.", { exact: true })).toBeHidden();
    await editor.getByRole("button", { name: config.save, exact: true }).click();
    await expect(editor.getByRole("status")).toContainText(config.success);
    await expect(editor.getByRole("button", { name: config.save, exact: true })).toBeDisabled();
    expect(attempts).toBe(2);
    await page.screenshot({ path: info.outputPath(`owner-${config.section.toLowerCase()}-saved.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 768, 1440]) {
  test(`owner admin: editor layouts and crisp swatches (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors } = await mountWorkspace(page);
    for (const [section, card, editorId] of [["Services", "service-card", "service-editor"], ["Team", "team-card", "barber-editor"]]) {
      await openOwnerSection(page, section);
      await page.getByTestId(card).first().click();
      const editor = page.getByTestId(editorId);
      await expect(editor.locator(".colour-swatch.sage")).toHaveCSS("background-color", "rgb(0, 120, 95)");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const axe = await new AxeBuilder({ page }).include("#workspace-main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
      await page.screenshot({ path: info.outputPath(`owner-${section.toLowerCase()}-${width}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  });
}


test("owner admin: discarding a service draft really resets it and pricing saves stay locked", async ({ page }) => {
  await mountWorkspace(page);
  await openOwnerSection(page, "Services");
  await page.getByTestId("service-card").first().click();
  const editor = page.getByTestId("service-editor");
  await editor.getByLabel("Service name", { exact: true }).fill("Discard this change");
  expect(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })).toBe(true);
  await editor.getByRole("button", { name: "Barbers & pricing", exact: true }).click();
  await editor.getByRole("button", { name: "Discard changes and continue", exact: true }).click();
  await editor.getByRole("button", { name: "Details", exact: true }).click();
  await expect(editor.getByLabel("Service name", { exact: true })).toHaveValue("Signature cut");
  expect(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })).toBe(false);
  await editor.getByRole("button", { name: "Barbers & pricing", exact: true }).click();
  const price = editor.getByLabel("Jay Carter price for Signature cut", { exact: true });
  await price.fill("31");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await page.route("**/api/app/service-rules", async route => { attempts++; await pending; await route.fulfill({ status: 503, json: { message: "Pricing save unavailable" } }); });
  await editor.getByRole("button", { name: "Save barber rules", exact: true }).click();
  await expect(price).toBeDisabled();
  await editor.getByRole("button", { name: "Details", exact: true }).click();
  await expect(editor.getByText("A save is in progress. Wait for its result before leaving this section.", { exact: true })).toBeVisible();
  release();
  await expect(editor.getByRole("alert").filter({ hasText: "Pricing save unavailable" })).toBeVisible();
  await expect(price).toHaveValue("31");
  await expect(price).toBeEnabled();
  expect(attempts).toBe(1);
});

test("owner admin: category rename keeps its input on failure and blocks duplicate saves", async ({ page }) => {
  await mountWorkspace(page);
  await openOwnerSection(page, "Services");
  await page.getByRole("button", { name: "Rename category Hair", exact: true }).click();
  const field = page.getByLabel("Rename category Hair", { exact: true });
  await field.fill("Haircuts");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await page.route("**/api/app/services/categories/rename", async route => { attempts++; await pending; await route.fulfill({ status: 503, json: { message: "Rename unavailable" } }); });
  await page.locator(".studio-rename").getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toBeDisabled();
  await expect(page.locator(".studio-rename").getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.locator(".studio-rename").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  release();
  await expect(page.locator(".studio-rename").getByRole("alert")).toContainText("Rename unavailable");
  await expect(field).toHaveValue("Haircuts");
  expect(attempts).toBe(1);
});


for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 600 }, { width: 768, height: 900 }, { width: 844, height: 390 }]) {
  test(`compact sidebar: centred icons, labels and reachable actions (${viewport.width}x${viewport.height})`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const { errors } = await mountWorkspace(page);
    const rail = page.getByTestId("rail");
    if (viewport.width > 980) {
      await page.getByTestId("sidebar-toggle").click();
      await expect(rail).toHaveAttribute("data-collapsed", "true");
      await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
    }
    await page.clock.runFor(300);
    const geometry = await rail.evaluate(el => {
      const rail = el.getBoundingClientRect();
      return { width: rail.width, icons: Array.from(el.querySelectorAll(".sidebar-item")).map(button => {
        const r = button.getBoundingClientRect(), icon = button.querySelector("svg")!.getBoundingClientRect();
        return { height: r.height, width: r.width, offset: Math.abs(icon.x + icon.width / 2 - (rail.x + rail.width / 2)) };
      }) };
    });
    expect(geometry.width).toBe(68);
    for (const icon of geometry.icons) {
      expect(icon.offset).toBeLessThanOrEqual(1);
      expect(icon.width).toBeGreaterThanOrEqual(44);
      expect(icon.height).toBeGreaterThanOrEqual(44);
    }
    const services = rail.getByRole("button", { name: "Services", exact: true });
    await services.focus();
    await expect(page.locator(".sidebar-tooltip")).toHaveText("Services");
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar-tooltip")).toHaveCount(0);
    await services.hover();
    await expect(page.locator(".sidebar-tooltip")).toHaveText("Services");
    await page.locator(".sidebar-tooltip").hover();
    await page.clock.runFor(200);
    await expect(page.locator(".sidebar-tooltip")).toBeVisible();
    await services.click();
    await expect(services).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".workspace-heading h1")).toHaveText("Services");
    const audit = rail.getByRole("button", { name: "Audit", exact: true });
    await audit.focus();
    const bounds = (await audit.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press("Enter");
    await expect(audit).toHaveAttribute("aria-current", "page");
    const axe = await new AxeBuilder({ page }).include(".sidebar").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations.map(v => v.id)).toEqual([]);
    await page.screenshot({ path: info.outputPath(`sidebar-${viewport.width}.png`) });
    if (viewport.width > 980) {
      await page.reload();
      await expect(rail).toHaveAttribute("data-collapsed", "true");
      const toggle = page.getByTestId("sidebar-toggle");
      const r = (await rail.boundingBox())!, t = (await toggle.boundingBox())!;
      expect(Math.abs(t.x + t.width / 2 - (r.x + r.width / 2))).toBeLessThanOrEqual(1);
      await toggle.click();
      await expect(rail).toHaveAttribute("data-collapsed", "false");
      await expect(services.locator(".sidebar-label")).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

test("collapsed desktop preference keeps full labels in the mobile drawer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { errors } = await mountWorkspace(page);
  await page.getByTestId("sidebar-toggle").click();
  await page.setViewportSize({ width: 390, height: 568 });
  await page.locator(".topbar-menu").click();
  const rail = page.getByTestId("rail");
  await expect(rail).toBeVisible();
  await expect(page.getByTestId("sidebar-toggle")).not.toBeVisible();
  const services = rail.getByRole("button", { name: "Services", exact: true });
  await expect(services.locator(".sidebar-label")).toBeVisible();
  await services.click();
  await expect(rail).not.toBeVisible();
  await expect(page.locator(".workspace-heading h1")).toHaveText("Services");
  await page.locator(".topbar-menu").click();
  await page.getByTestId("sidebar-close").click();
  await expect(rail).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});


for (const width of [320, 768, 1440]) {
  test(`header search wallet and waiting-list controls stay usable (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors } = await mountWorkspace(page);
    const search = page.getByRole("button", { name: "Search", exact: true });
    for (const control of [search, page.getByTestId("wallet-chip"), page.getByTestId("queue-chip")]) {
      await expect(control).toBeVisible();
      const b = (await control.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(40);
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(width);
      const icon = (await control.locator("svg").first().boundingBox())!;
      expect(icon.width).toBeGreaterThanOrEqual(16);
    }
    await search.click();
    await expect(page.getByLabel("Search everything")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(search).toBeFocused();
    await page.getByTestId("queue-chip").click();
    await expect(page.getByRole("dialog", { name: "Waiting list", exact: true })).toBeVisible();
    const axe = await new AxeBuilder({ page }).include(".queue-drawer").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`queue-header-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

test("customer search rejects late results and supports error retry and keyboard selection", async ({ page }) => {
  const { errors } = await mountWorkspace(page);
  let releaseOld!: () => void, retry = false;
  const old = new Promise<void>(resolve => { releaseOld = resolve; });
  const customer = (id: string, name: string) => ({ id, name, phone: "07700900801", visits: 2 });
  await page.route("**/api/app/customers?**", async route => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "Ada") { await old; return route.fulfill({ json: { customers: [customer("old", "Ada Old")] } }); }
    if (q === "Broken" && !retry) return route.fulfill({ status: 503, json: { message: "Lookup unavailable" } });
    return route.fulfill({ json: { customers: q === "Zelda" || retry ? [customer("new", "Zelda New")] : [] } });
  });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const input = page.getByLabel("Search everything");
  await input.fill("Ada"); await page.clock.runFor(150);
  await input.fill("Zelda"); await page.clock.runFor(150);
  await expect(page.getByRole("option").filter({ hasText: "Zelda New" })).toBeVisible();
  releaseOld();
  await expect(page.getByRole("option").filter({ hasText: "Ada Old" })).toHaveCount(0);
  await input.fill("Broken"); await page.clock.runFor(150);
  await expect(page.getByRole("button", { name: "Retry customer search" })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);
  await input.press("ArrowDown"); await input.press("Enter");
  await expect(page.getByTestId("search-palette")).toBeVisible();
  retry = true;
  await page.getByRole("button", { name: "Retry customer search" }).click(); await page.clock.runFor(150);
  await expect(page.getByRole("option").filter({ hasText: "Zelda New" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(input).toHaveValue(""); await expect(input).toBeFocused();
  const axe = await new AxeBuilder({ page }).include(".palette").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
  expect(errors).toEqual([]);
});

test("wallet hides previous period totals, retries failures and retains focus", async ({ page }) => {
  const { errors } = await mountWorkspace(page);
  let fail = true;
  await page.route("**/api/app/wallet?**", route => {
    if (fail) return route.fulfill({ status: 503, json: { message: "Wallet unavailable" } });
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { from: params.get("from"), to: params.get("to"), today, till_access: "OWNER", totals: { service: 2800, tips: 0, discounts: 0, visits: 1, voided: 0, unpaid_value: 0, unpaid_visits: 0 }, by_method: {}, by_staff: [], payments: [] } });
  });
  await page.getByTestId("wallet-chip").click();
  await expect(page.getByRole("button", { name: "Retry wallet" })).toBeVisible();
  await expect(page.locator(".wallet-hero")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Retry wallet" }).click();
  await expect(page.locator(".wallet-hero")).toContainText("£28");
  const drawer = page.getByTestId("wallet-drawer");
  await drawer.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".wallet-hero")).toContainText("£28");
  fail = true;
  await drawer.getByRole("button", { name: "This month" }).click();
  await expect(page.getByRole("button", { name: "Retry wallet" })).toBeVisible();
  await expect(page.locator(".wallet-hero")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("wallet-chip")).toBeFocused();
  expect(errors).toEqual([]);
});

test("waiting list preserves date ranges, reports load errors, and sends one offer", async ({ page }) => {
  const { errors } = await mountWorkspace(page);
  let loadFails = true, sends = 0, release!: () => void;
  const sending = new Promise<void>(resolve => { release = resolve; });
  const entry = { id: "waiting", staff_id: "staff-0", service_id: "cut", customer_name: "Waiting Wendy", phone: "07700900900", email: "", date: "2030-01-05", date_to: "2030-01-09", daypart: "ANY", notes: "", status: "OPEN", version: 0, created_at: now, service_name: "Signature cut", staff_name: "Jay Carter", offer_id: null, offers_made: 0 };
  await page.route("**/api/app/waitlist**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/matches")) return route.fulfill({ json: { matches: [{ date: today, staff_id: "staff-0", staff_name: "Jay Carter", start_min: 660, price_pence: 2800, duration_min: 30 }] } });
    if (path.endsWith("/offer")) { sends++; await sending; entry.status = "OFFERED"; entry.version++; return route.fulfill({ json: { offer: { link: "https://ui.test/offer/example", body: "Your appointment offer" } } }); }
    if (loadFails) return route.fulfill({ status: 503, json: { message: "Queue unavailable" } });
    return route.fulfill({ json: { waitlist: [entry], counts: { OPEN: 1 } } });
  });
  await page.reload();
  await page.getByTestId("queue-chip").click();
  await expect(page.getByRole("button", { name: "Retry waiting list" })).toBeVisible();
  await expect(page.getByTestId("queue-drawer")).not.toContainText("No one is waiting");
  loadFails = false;
  await page.getByRole("button", { name: "Retry waiting list" }).click();
  await expect(page.getByTestId("queue-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Today · 1", exact: true }).click();
  await expect(page.getByTestId("queue-row")).toContainText("Waiting Wendy");
  await page.getByTestId("queue-offer").click();
  await page.getByTestId("queue-match").click();
  await expect(page.getByTestId("queue-match")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("queue-offer-picker")).toBeVisible();
  release();
  await expect(page.getByTestId("offer-sent")).toContainText("Offer created for Waiting Wendy");
  await expect(page.getByTestId("offer-sent")).toContainText("Delivery is not confirmed");
  expect(sends).toBe(1);
  expect(errors).toEqual([]);
});


for (const viewport of [{ width: 320, height: 700 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
  test(`owner menu audit: keyboard shortcuts and sign-out recovery (${viewport.width}px)`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const { errors } = await mountWorkspace(page);
    await page.route("**/api/app/billing", route => route.fulfill({ status: 503, json: { message: "Billing unavailable in this isolated fixture" } }));
    const trigger = page.getByTestId("account-pill");
    await trigger.click();
    const menu = page.getByTestId("account-menu");
    await expect(menu.getByRole("menuitem", { name: "Account & team", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByTestId("sign-out")).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Shop settings", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await menu.getByRole("menuitem", { name: "Password & security" }).click();
    await expect(page).toHaveURL(/#settings\/security$/);
    await trigger.click();
    await menu.getByRole("menuitem", { name: "Plan & billing" }).click();
    await expect(page).toHaveURL(/#settings\/billing$/);
    let calls = 0;
    await page.route("**/api/app/auth/logout", route => { calls++; return route.fulfill({ status: 503, json: { message: "Not available" } }); });
    await trigger.click();
    await page.getByTestId("sign-out").click();
    await expect(menu.getByRole("alert")).toContainText("Could not sign out");
    await expect(page.getByTestId("sign-out")).toBeEnabled();
    expect(calls).toBe(1);
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    const axe = await new AxeBuilder({ page }).include(".account-menu").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.screenshot({ path: info.outputPath(`owner-menu-${viewport.width}.png`) });
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 768, 1440]) {
  test(`shifts audit: week bookings, retry and dated-hours protection (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors } = await mountWorkspace(page);
    let fail = true;
    await page.route("**/api/app/bookings/range?**", route => fail ? route.fulfill({ status: 503, json: { message: "Unavailable" } }) : route.fulfill({ json: { bookings: [...bookings, { ...bookings[1], id: "tomorrow", date: "2030-01-08" }], truncated: false } }));
    if (width < 768) await page.getByTestId("topbar-menu").click();
    await page.getByTestId("rail").getByRole("button", { name: "Shifts", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry roster" })).toBeVisible();
    await expect(page.locator(".shifts-summary")).toContainText("totals unavailable");
    fail = false; await page.getByRole("button", { name: "Retry roster" }).click();
    await expect(page.locator(".shifts-summary")).toContainText("6 appointments");
    await page.getByTestId("shifts-tab-day").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("shifts-tab-week")).toBeFocused();
    await expect(page.getByRole("button", { name: /Marcus Reed Tue,? 8 Jan/ })).toContainText("1 booked");
    await page.getByRole("button", { name: /Marcus Reed Tue,? 8 Jan/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator('input[name="date"]')).toHaveValue("2030-01-08");
    await expect(dialog.locator('input[name="starts"]')).toHaveAttribute("step", "900");
    await page.keyboard.press("Escape");
    await page.getByTestId("shifts-tab-leave").click();
    await expect(page.getByTestId("shifts-leave")).toBeVisible();
    await page.getByRole("button", { name: "Add closure" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Add shop closure" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("shifts-tab-day").click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const axe = await new AxeBuilder({ page }).include(".shifts").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.screenshot({ path: info.outputPath(`shifts-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

test("calendar audit: staff menu keyboard and resize cancellation", async ({ page }) => {
  const { errors, mutations } = await mountWorkspace(page);
  const trigger = page.getByRole("button", { name: "Jay Carter: day actions" });
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "Edit this day's hours" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Block time…" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  const event = page.locator(".calendar-event").filter({ hasText: "Riley Chen" });
  const handle = event.getByTestId("resize-handle");
  await handle.scrollIntoViewIfNeeded();
  const r = (await handle.boundingBox())!;
  await page.mouse.move(r.x + r.width/2,r.y + r.height/2); await page.mouse.down();
  await page.mouse.move(r.x + r.width/2,r.y + 60,{ steps: 6 });
  await expect(page.getByTestId("resize-label")).toBeVisible();
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(page.getByTestId("resize-label")).toHaveCount(0);
  expect(mutations).toHaveLength(0);
  expect(await page.locator("body").evaluate(el => el.classList.contains("is-dragging-appointment"))).toBe(false);
  expect(errors).toEqual([]);
});


test("calendar audit: an empty staff filter can recover without losing the timetable", async ({ page }) => {
  const { errors } = await mountWorkspace(page);
  await page.getByTestId("filters-toggle").click();
  const filter = page.getByLabel("Barber filter");
  // Simulate a saved filter referencing a team member removed by another user.
  await filter.evaluate((select: HTMLSelectElement) => { select.add(new Option("Removed team member", "removed")); });
  await filter.selectOption("removed");
  await expect(page.locator(".calendar-empty")).toBeVisible();
  await filter.selectOption("");
  await expect(page.locator(".calendar-board")).toBeVisible();
  expect(errors).toEqual([]);
});

test("shifts audit: pending conflict saves stay protected and failures can be retried", async ({ page }) => {
  const { errors } = await mountWorkspace(page);
  const conflict = { booking_id: "booking-3", ref: "BRB-0004", version: 0, staff_id: "staff-0", staff_name: "Jay Carter", customer_name: "Riley Chen", attendee_name: "", phone: "07700900000", email: "", contact_pref: "NONE", channel: null, service_id: "cut", service_name: "Signature cut", date: today, start_min: 645, duration_min: 30, price_pence: 2800, deposit_status: "NONE", deposit_paid_pence: 0, series_id: null, reason: "Outside working hours", suggestions: [] };
  await page.route("**/api/app/schedule/preview", route => route.fulfill({ json: { conflicts: [conflict], summary: { count: 1, value_pence: 2800, deposits_pence: 0 }, window: { from: today, to: today } } }));
  let release!: () => void, calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/app/schedule/apply", async route => {
    calls++;
    if (calls === 1) { await pending; return route.fulfill({ status: 503, json: { message: "Could not save the schedule" } }); }
    return route.fulfill({ json: { outcome: [{ booking_id: "booking-3", action: "LATER", ok: true, note: "Left for review", notified: [] }] } });
  });
  await page.getByTestId("rail").getByRole("button", { name: "Shifts", exact: true }).click();
  await page.getByTestId("shift-edit").first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Save changes", exact: true }).click();
  const resolver = page.getByTestId("conflict-resolver");
  await expect(resolver).toBeVisible();
  await page.getByTestId("conflict-apply").click();
  await expect(resolver).toHaveAttribute("aria-busy", "true");
  await page.keyboard.press("Escape");
  await expect(resolver).toBeVisible();
  await resolver.evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(calls).toBe(1);
  release();
  await expect(resolver.getByRole("alert")).toContainText("Could not save the schedule");
  await page.getByTestId("conflict-apply").click();
  await expect(page.getByTestId("conflict-outcome")).toContainText("1 of 1 decision applied");
  expect(calls).toBe(2);
  expect(errors).toEqual([]);
});

async function mountSetup(page: Page, step = "shop") {
  const base = await mountWorkspace(page);
  const w = structuredClone(workspace);
  Object.assign(w.shop, { email: w.account.email, phone: "", kind: "BARBER", lead_time_min: 60, booking_window_days: 28, setup_json: JSON.stringify({ step, done: [], skipped: [] }) });
  let state = { step, done: [] as string[], skipped: [] as string[], completed_at: null };
  let record: any = { version: 3, logo_url: "", cover_url: "", strapline: "Original", accent: "ink", theme_json: '{"font":"editorial","mode":"light"}', copy_json: '{"hero.button":"Pick your cut"}', element_styles_json: '{"hero.title":{"fg":"#112233"}}', sections_json: '["hero","services"]', gallery_json: '[]', published: 1 };
  const writes: { path: string; body: any }[] = [];
  await page.route("https://ui.test/api/app/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/app", "");
    if (path === "/workspace") return route.fulfill({ json: w });
    if (path === "/setup") return route.fulfill({ json: { state, kind: "BARBER", bank_holidays: {}, progress: { shop: { saved: true }, services: { count: 1 }, team: { staff: 3 }, messages: { providers: { sms: { provider: "mailbox" }, email: { provider: "mailbox" } } }, online: { slug: "northline", live: true }, payments: {} } } });
    if (path === "/setup/state") {
      const body = route.request().postDataJSON(); writes.push({ path, body });
      state = { ...state, ...(body.step ? { step: body.step } : {}), done: body.done ? [...state.done, body.done] : state.done };
      return route.fulfill({ json: { state } });
    }
    if (path === "/shop/page") {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON(); writes.push({ path, body });
        record = { ...record, ...body, version: record.version + 1, theme_json: JSON.stringify(body.theme), copy_json: JSON.stringify(body.copy), element_styles_json: JSON.stringify(body.element_styles) };
        w.logo_url = body.logo_url;
      }
      return route.fulfill({ json: { page: record } });
    }
    if (path === "/setup/contact" || path === "/shop" || path === "/setup/policy") {
      const body = route.request().postDataJSON(); writes.push({ path, body });
      Object.assign(w.shop, body, { version: w.shop.version + 1 });
      if (body.week) w.shop.week_json = JSON.stringify(body.week);
      return route.fulfill({ json: { shop: w.shop, ok: true } });
    }
    if (path === "/setup/starter") return route.fulfill({ json: { menu: [] } });
    return route.fallback();
  });
  await page.goto("https://ui.test/workspace/setup");
  await expect(page.getByTestId("setup-wizard")).toBeVisible();
  return { ...base, writes, w };
}

for (const width of [390, 1440]) {
  test(`setup audit: logo upload waits, brand preserves custom content and retries (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const { writes, errors } = await mountSetup(page, "brand");
    await expect(page.getByTestId("setup-brand")).toBeVisible();
    let release!: () => void;
    await page.route("**/api/app/media", async route => {
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ status: 201, json: { media: { id: "logo", url: "/static/stock/tools.webp" } } });
    });
    await page.getByTestId("setup-upload-logo-input").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from("test image fixture") });
    await expect(page.getByTestId("setup-exit")).toBeDisabled();
    await expect(page.getByTestId("setup-next")).toBeDisabled();
    await expect.poll(() => !!release).toBe(true); release();
    await expect(page.getByLabel("Logo URL")).toHaveValue("/static/stock/tools.webp");
    await page.getByTestId("setup-strapline").fill("Fresh branding");
    page.once("dialog", d => d.dismiss());
    await page.getByTestId("setup-exit").click();
    await expect(page.getByTestId("setup-brand")).toBeVisible();
    let fails = true;
    await page.route("**/api/app/shop/page", route => route.request().method() === "PUT" && fails ? route.fulfill({ status: 503, json: { message: "Brand save unavailable" } }) : route.fallback());
    await page.getByTestId("setup-next").click();
    await expect(page.getByRole("alert")).toContainText("Brand save unavailable");
    await expect(page.getByTestId("setup-strapline")).toHaveValue("Fresh branding");
    fails = false;
    const retryRequest = page.waitForRequest(r => new URL(r.url()).pathname === "/api/app/shop/page" && r.method() === "PUT");
    await page.getByTestId("setup-next").click();
    const body = (await retryRequest).postDataJSON();
    await expect(page.getByRole("heading", { name: "Opening hours", exact: true })).toBeVisible();
    expect(body).toMatchObject({ logo_url: "/static/stock/tools.webp", strapline: "Fresh branding", copy: { "hero.button": "Pick your cut" }, element_styles: { "hero.title": { fg: "#112233" } }, theme: { font: "editorial" } });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`setup audit: timezone is saved, navigation guarded and hours preserve preferences (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const { writes, errors, w } = await mountSetup(page);
    await page.getByLabel("Timezone", { exact: true }).fill("Europe/Paris");
    page.once("dialog", d => d.dismiss());
    await page.locator(".setup-flow-rail").getByRole("button", { name: /^Hours/ }).click();
    await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue("Europe/Paris");
    await page.getByTestId("setup-next").click();
    await expect(page.getByTestId("setup-brand")).toBeVisible();
    expect(writes.find(x => x.path === "/setup/contact")?.body.timezone).toBe("Europe/Paris");
    await page.locator(".setup-flow-rail").getByRole("button", { name: /^Hours/ }).click();
    await page.getByLabel("Monday opens").fill("10:00");
    await page.getByTestId("setup-next").click();
    await expect(page.getByRole("heading", { name: "Services & prices", exact: true })).toBeVisible();
    expect(writes.find(x => x.path === "/shop")?.body).toMatchObject({ buffer_min: w.shop.buffer_min, card_colour: w.shop.card_colour, calendar_density: w.shop.calendar_density });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("setup audit: honest brand load failure and booking terms work without a slug", async ({ page }) => {
  const { writes, w, errors } = await mountSetup(page, "shop");
  let fail = true;
  await page.route("**/api/app/shop/page", route => fail ? route.fulfill({ status: 503, json: { message: "Brand could not load" } }) : route.fallback());
  await page.locator(".setup-flow-rail").getByRole("button", { name: /^Brand/ }).click();
  await expect(page.getByRole("alert")).toContainText("Brand could not load");
  await expect(page.getByTestId("setup-next")).toHaveCount(0);
  fail = false; await page.getByRole("button", { name: "Retry loading brand" }).click();
  await expect(page.getByTestId("setup-brand")).toBeVisible();
  const axe = await new AxeBuilder({ page }).include("#workspace-main").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  w.shop.slug = "";
  await page.locator(".setup-flow-rail").getByRole("button", { name: /^Terms/ }).click();
  await page.getByTestId("setup-cancel").selectOption("0");
  await page.getByTestId("setup-terms-starter").click();
  await expect(page.getByTestId("setup-terms-text")).toHaveValue(/at least 0 hours/);
  await page.getByTestId("setup-next").click();
  await expect.poll(() => writes.some(x => x.path === "/setup/policy")).toBe(true);
  expect(writes.find(x => x.path === "/setup/policy")!.body).toMatchObject({ cancel_hours: 0, version: 0 });
  expect(errors).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`owner signup audit: validation, failed-save recovery and setup handoff (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const { errors } = await mountSetup(page);
    let signedIn = false;
    const bodies: any[] = [];
    await page.route("**/api/app/workspace", route => signedIn ? route.fallback() : route.fulfill({ status: 401, json: { message: "Sign in required" } }));
    await page.route("**/api/app/auth/me", route => route.fulfill({ json: { account: null, demo: false } }));
    await page.route("**/api/app/auth/slug-check?*", route => route.fulfill({ json: { ok: true, reason: "", host: "" } }));
    await page.route("**/api/app/auth/signup", async route => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) return route.fulfill({ status: 503, json: { message: "Temporary signup failure" } });
      signedIn = true;
      return route.fulfill({ status: 201, json: { ok: true, workspace_url: "https://ui.test/workspace", cross_host_session: false } });
    });
    await page.goto("https://ui.test/signup");
    await expect(page.getByRole("heading", { name: "Set up your shop" })).toBeVisible();
    await page.getByLabel("Shop name", { exact: true }).fill("New Barber Shop");
    await page.locator('input[name="slug"]').fill("ab");
    await page.getByLabel("Your name", { exact: true }).fill("New Owner");
    await page.getByLabel("Email", { exact: true }).fill("new-owner@example.test");
    await page.getByLabel("Password", { exact: true }).fill("New-owner-password-123");
    await page.getByRole("button", { name: "Create shop", exact: true }).click();
    expect(bodies).toHaveLength(0);
    await page.locator('input[name="slug"]').fill("new-barber-shop");
    await page.getByTestId("accept-legal").getByRole("checkbox").check();
    await page.getByTestId("signup-kind-SALON").click();
    await page.getByRole("button", { name: "Create shop", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Temporary signup failure" })).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("new-owner@example.test");
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("New-owner-password-123");
    await page.getByRole("button", { name: "Create shop", exact: true }).click();
    await expect(page.getByTestId("setup-wizard")).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ shop_name: "New Barber Shop", slug: "new-barber-shop", name: "New Owner", kind: "SALON", accept_legal: true });
    expect(errors).toEqual([]);
  });
}

test("setup audit: invalid booking addresses cannot advance and payment failures remain retryable", async ({ page }) => {
  const { writes, errors } = await mountSetup(page, "online");
  await page.route("**/api/app/setup/slug?*", route => route.fulfill({ json: { ok: false, reason: "Address already taken" } }));
  await page.getByTestId("setup-slug").fill("taken-address");
  await page.clock.runFor(300);
  await expect(page.getByText("Address already taken", { exact: true })).toBeVisible();
  await page.getByTestId("setup-next").click();
  await expect(page.getByRole("alert")).toContainText("Address already taken");
  expect(writes).toHaveLength(0);
  let failed = true;
  const payBodies: any[] = [];
  await page.route("**/api/app/shop/payments", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { stripe: { provider: "stripe", mode: "test" }, active: true, shop_account: { state: { key: "active" } }, settings: { deposits_online: 1, deposit_pence: 500, deposit_hold_min: 10, payment_mode: "DEPOSIT", payout_tier: "STANDARD", payrun_auto: "OFF", payrun_reserve_bps: 0 } } });
    payBodies.push(route.request().postDataJSON());
    return route.fulfill(failed ? { status: 503, json: { message: "Payment settings could not save" } } : { json: { ok: true } });
  });
  page.once("dialog", d => d.accept());
  await page.locator(".setup-flow-rail").getByRole("button", { name: "Payments", exact: true }).click();
  await page.getByTestId("setup-deposit").fill("15");
  await page.getByTestId("setup-next").click();
  await expect(page.getByRole("alert")).toContainText("Payment settings could not save");
  expect(writes.some(x => x.path === "/setup/state" && x.body.complete)).toBe(false);
  expect(payBodies[0]).toMatchObject({ deposit_pence: 1500, payment_mode: "DEPOSIT" });
  await expect(page.getByTestId("setup-deposit")).toHaveValue("15");
  failed = false;
  await page.getByTestId("setup-next").click();
  await expect.poll(() => writes.some(x => x.path === "/setup/state" && x.body.complete)).toBe(true);
  expect(errors).toEqual([]);
});

test("setup audit: Continue does not silently discard an unfinished team member", async ({ page }) => {
  const { writes, errors } = await mountSetup(page, "shop");
  await page.route("**/api/app/auth/access", route => route.fulfill({ json: { members: [], invitations: [], providers: { sms: { provider: "mailbox" }, email: { provider: "mailbox" } } } }));
  await page.locator(".setup-flow-rail").getByRole("button", { name: "Team", exact: true }).click();
  await page.getByTestId("setup-add-name").fill("Unsaved barber");
  page.once("dialog", d => d.dismiss());
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("setup-add-name")).toHaveValue("Unsaved barber");
  expect(writes.some(x => x.path === "/setup/state" && x.body.done === "team")).toBe(false);
  await page.getByTestId("setup-add-name").fill("");
  await page.getByTestId("setup-next").click();
  await expect(page.getByRole("heading", { name: "Customer messages", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

function editorStore() {
  return {
    failDraft: false, failPublish: false, failDiscard: false, failLoad: false,
    holdDraft: null as Promise<void> | null, writes: [] as { kind: string; body: any }[],
    record: { version: 0, strapline: "Original strapline", logo_url: "", cover_url: "", accent: "ink", published: 1, sections_json: '["hero","services","team","gallery","reviews"]', copy_json: '{}', element_styles_json: '{}', theme_json: '{}', gallery_json: '[]', draft_json: null, draft_updated_at: null } as any,
  };
}
async function mountEditor(page: Page, state = editorStore()) {
  const base = await mountWorkspace(page);
  await page.route("**/api/app/shop/page**", async route => {
    const draft = new URL(route.request().url()).pathname.endsWith("/draft");
    const method = route.request().method();
    if (method === "GET") return route.fulfill(state.failLoad ? { status: 503, json: { message: "Page loading unavailable" } } : { json: { page: state.record } });
    const body = route.request().postDataJSON();
    const kind = method === "DELETE" ? "discard" : draft ? "draft" : "publish";
    state.writes.push({ kind, body });
    if (kind === "draft" && state.holdDraft) await state.holdDraft;
    if ((kind === "draft" && state.failDraft) || (kind === "publish" && state.failPublish) || (kind === "discard" && state.failDiscard)) return route.fulfill({ status: 503, json: { message: `${kind} unavailable` } });
    const record = state.record;
    if (body.version !== record.version || (body.expected_draft_at ?? null) !== record.draft_updated_at) return route.fulfill({ status: 409, json: { message: "Page changed elsewhere" } });
    const { expected_draft_at: _expected, ...content } = body;
    if (kind === "draft") state.record = { ...record, draft_json: JSON.stringify(content), draft_updated_at: (record.draft_updated_at ?? now) + 1 };
    else if (kind === "discard") state.record = { ...record, draft_json: null, draft_updated_at: null, version: record.version + 1 };
    else state.record = { ...record, ...content, draft_json: null, draft_updated_at: null, version: record.version + 1, theme_json: JSON.stringify(body.theme), gallery_json: JSON.stringify(body.gallery), sections_json: JSON.stringify(body.sections), variants_json: JSON.stringify(body.variants), element_styles_json: JSON.stringify(body.element_styles), copy_json: JSON.stringify(body.copy) };
    return route.fulfill({ json: { ok: true, page: state.record, draft_updated_at: state.record.draft_updated_at } });
  });
  await page.goto("https://ui.test/workspace/website");
  await expect(page.getByTestId("wed-publish")).toBeVisible();
  await page.getByTestId("wed-panel-content").click();
  return { ...base, state };
}

test("website editor: serial drafts finish before publish and never recreate a published draft", async ({ page }) => {
  const { state, errors } = await mountEditor(page);
  let release!: () => void;
  state.holdDraft = new Promise<void>(r => { release = r; });
  await page.getByTestId("wed-strapline").fill("First draft");
  await page.clock.runFor(750);
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByTestId("wed-strapline").fill("Latest draft");
  await page.clock.runFor(750);
  expect(state.writes).toHaveLength(1);
  await page.getByTestId("wed-publish").click();
  await expect(page.getByTestId("wed-close")).toBeDisabled();
  await expect(page.locator(".wed-left")).toHaveAttribute("inert", "");
  expect(state.writes).toHaveLength(1);
  state.holdDraft = null; release();
  await expect(page.getByTestId("wed-save")).toHaveText("Published");
  expect(state.writes.map(x => x.kind)).toEqual(["draft", "draft", "publish"]);
  expect(state.writes.at(-1)!.body.strapline).toBe("Latest draft");
  await page.clock.runFor(2000);
  expect(state.writes).toHaveLength(3);
  await expect(page.getByTestId("wed-undo")).toBeDisabled();
  expect(errors).toEqual([]);
});

test("website editor: discard waits, preserves input on failure and fences pending saves", async ({ page }) => {
  const { state, errors } = await mountEditor(page);
  let release!: () => void;
  state.holdDraft = new Promise<void>(r => { release = r; });
  await page.getByTestId("wed-strapline").fill("Discard me");
  await page.clock.runFor(750);
  await expect.poll(() => state.writes.length).toBe(1);
  state.failDiscard = true;
  page.on("dialog", d => d.accept());
  await page.getByTestId("wed-discard").click();
  expect(state.writes.map(x => x.kind)).toEqual(["draft"]);
  state.holdDraft = null; release();
  await expect(page.getByRole("alert")).toContainText("discard unavailable");
  await expect(page.getByTestId("wed-strapline")).toHaveValue("Discard me");
  state.failDiscard = false;
  await page.getByTestId("wed-discard").click();
  await expect(page.getByTestId("wed-strapline")).toHaveValue("Original strapline");
  await expect(page.getByTestId("wed-save")).toHaveText("Published");
  await page.clock.runFor(2000);
  expect(state.writes.map(x => x.kind)).toEqual(["draft", "discard", "discard"]);
  await page.getByTestId("wed-strapline").fill("Next draft");
  await page.clock.runFor(750);
  await expect(page.getByTestId("wed-save")).toContainText("Draft saved");
  expect(state.writes.at(-1)!.body.version).toBe(1);
  expect(errors).toEqual([]);
});

test("website editor: close flushes unsaved text, errors stay visible after reopening a draft", async ({ page }) => {
  const { state, errors } = await mountEditor(page);
  await page.getByTestId("wed-strapline").fill("Saved before closing");
  await page.getByTestId("wed-close").click();
  await expect(page.getByTestId("website-editor")).toHaveCount(0);
  expect(state.writes.at(-1)!.body.strapline).toBe("Saved before closing");
  const writes = state.writes.length;
  await page.clock.runFor(1500); expect(state.writes).toHaveLength(writes);
  await page.goto("https://ui.test/workspace/website");
  await page.getByTestId("wed-panel-content").click();
  await expect(page.getByTestId("wed-strapline")).toHaveValue("Saved before closing");
  state.failDraft = true;
  await page.getByTestId("wed-strapline").fill("Keep this failed edit");
  await page.clock.runFor(750);
  await expect(page.getByTestId("wed-save")).toHaveText("Draft not saved");
  await page.getByTestId("wed-close").click();
  await expect(page.getByRole("alert")).toContainText("could not be saved");
  await expect(page.getByTestId("wed-strapline")).toHaveValue("Keep this failed edit");
  state.failDraft = false;
  await page.getByRole("button", { name: "Retry saving draft" }).click();
  await expect(page.getByTestId("wed-save")).toContainText("Draft saved");
  expect(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })).toBe(false);
  expect(errors).toEqual([]);
});

for (const width of [320, 768, 1440]) {
  test(`website editor: mobile controls, keyboard history and image upload guard (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors } = await mountEditor(page);
    await expect(page.getByTestId("wed-save")).toBeVisible();
    await expect(page.getByTestId("wed-undo")).toBeVisible();
    await expect(page.getByTestId("wed-device-phone")).toBeVisible();
    await page.getByTestId("wed-strapline").fill("History change");
    const nativeUndo = await page.getByTestId("wed-strapline").evaluate(el => { const e = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; });
    expect(nativeUndo).toBe(false);
    await page.getByTestId("wed-undo").click();
    await expect(page.getByTestId("wed-strapline")).toHaveValue("Original strapline");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(page.getByTestId("wed-strapline")).toHaveValue("History change");
    let release!: () => void;
    await page.route("**/api/app/media", async route => { await new Promise<void>(r => { release = r; }); await route.fulfill({ status: 201, json: { media: { id: "photo", url: "/static/stock/tools.webp" } } }); });
    await page.getByTestId("wed-logo-upload-input").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from("isolated upload") });
    await expect(page.getByTestId("wed-publish")).toBeDisabled();
    await expect(page.getByTestId("wed-close")).toBeDisabled();
    await expect(page.getByTestId("wed-save")).toHaveText("Uploading image…");
    await expect.poll(() => !!release).toBe(true); release();
    await expect(page.getByTestId("wed-logo").locator("img")).toHaveAttribute("src", "/static/stock/tools.webp");
    await expect(page.getByTestId("wed-publish")).toBeEnabled();
    await page.getByTestId("wed-panel-content").focus(); await page.keyboard.press("Home");
    await expect(page.getByTestId("wed-panel-sections")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("wed-panel-design")).toBeFocused();
    const axe = await new AxeBuilder({ page }).include(".wed-top").include(".wed-left").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`website-editor-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

test("website editor: failed publish is retryable, hidden page state is accurate and loading can retry", async ({ page }) => {
  const { state, errors } = await mountEditor(page);
  state.failPublish = true;
  await page.getByTestId("wed-strapline").fill("Not lost on publish failure");
  await page.getByTestId("wed-publish").click();
  await expect(page.getByRole("alert")).toContainText("publish unavailable");
  await expect(page.getByTestId("wed-save")).toHaveText("Draft not saved");
  await page.getByRole("button", { name: "Retry saving draft" }).click();
  await expect(page.getByTestId("wed-save")).toContainText("Draft saved");
  state.failPublish = false;
  await page.getByRole("checkbox", { name: /Page is public/ }).uncheck();
  await page.getByTestId("wed-publish").click();
  await expect(page.getByTestId("wed-save")).toHaveText("Page hidden");
  expect(state.writes.at(-1)!.body.published).toBe(0);
  await page.getByTestId("wed-close").click();
  state.failLoad = true;
  await page.goto("https://ui.test/workspace/website");
  await expect(page.getByRole("alert")).toContainText("Page loading unavailable");
  state.failLoad = false;
  await page.getByRole("button", { name: "Retry loading page" }).click();
  await expect(page.getByTestId("wed-save")).toHaveText("Page hidden");
  expect(errors).toEqual([]);
});

test("website editor: gallery rejects excess files and retains successful partial uploads", async ({ page }) => {
  const { errors } = await mountEditor(page);
  let requests = 0;
  await page.route("**/api/app/media", async route => {
    requests++;
    await route.fulfill(requests === 1 ? { status: 201, json: { media: { id: "one", url: "/static/stock/tools.webp" } } } : { status: 503, json: { message: "Second photo could not upload" } });
  });
  const photo = { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("isolated file") };
  await page.getByTestId("wed-gallery-upload-input").setInputFiles(Array.from({ length: 13 }, () => photo));
  await expect(page.getByRole("alert")).toContainText("Choose up to 12 more photos");
  expect(requests).toBe(0);
  await page.getByTestId("wed-gallery-upload-input").setInputFiles([photo, photo]);
  await expect(page.locator(".wed-gallery figure")).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("Second photo could not upload");
  await expect(page.getByTestId("wed-close")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("website editor: inspector focus returns and removing element overrides keeps the palette", async ({ page }) => {
  const { state, errors } = await mountEditor(page);
  await page.getByTestId("wed-panel-design").click();
  await page.getByTestId("wed-tok-page-text").fill("#112233");
  await page.getByTestId("wed-panel-sections").click();
  await page.getByTestId("wed-sec-services").click();
  await expect(page.getByTestId("wed-inspector")).toBeFocused();
  await page.getByTestId("wed-el-fg-text").fill("#ffffff");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("wed-sec-services")).toBeFocused();
  await page.getByTestId("wed-panel-design").click();
  await page.getByTestId("wed-reset-elements").click();
  await page.clock.runFor(750);
  await expect(page.getByTestId("wed-save")).toContainText("Draft saved");
  expect(state.writes.at(-1)!.body.element_styles).toEqual({ "page.bg": { bg: "#112233" } });
  expect(errors).toEqual([]);
});

for (const width of [320, 1440]) {
  test(`website editor conflict: two editors preserve local work and recover safely (${width}px)`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    const { state, errors } = await mountEditor(page);
    const other = await context.newPage();
    const remote = await mountEditor(other, state);
    await other.getByTestId("wed-strapline").fill("Other editor's saved draft");
    await other.clock.runFor(750);
    await expect(other.getByTestId("wed-save")).toContainText("Draft saved");
    const latestStamp = state.record.draft_updated_at;
    await page.getByTestId("wed-strapline").fill("My unsaved local wording");
    await page.clock.runFor(750);
    await expect(page.getByTestId("wed-save")).toHaveText("Draft conflict · paused");
    await expect(page.getByTestId("wed-publish")).toBeDisabled();
    await expect(page.getByTestId("wed-discard")).toBeDisabled();
    expect(JSON.parse(state.record.draft_json).strapline).toBe("Other editor's saved draft");
    const count = state.writes.length;
    await page.getByTestId("wed-strapline").fill("My local wording kept for export");
    await page.clock.runFor(2000);
    expect(state.writes).toHaveLength(count);
    expect(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })).toBe(true);
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download my draft" }).click();
    const download = await downloadEvent;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    expect(exported.page.strapline).toBe("My local wording kept for export");
    expect(exported.page).not.toHaveProperty("expected_draft_at");
    page.once("dialog", d => d.dismiss());
    await page.getByRole("button", { name: "Load latest draft" }).click();
    await expect(page.getByTestId("wed-strapline")).toHaveValue("My local wording kept for export");
    state.failLoad = true;
    page.once("dialog", d => d.accept());
    await page.getByRole("button", { name: "Load latest draft" }).click();
    await expect(page.getByTestId("wed-feedback")).toContainText("Page loading unavailable");
    await expect(page.getByTestId("wed-strapline")).toHaveValue("My local wording kept for export");
    const axe = await new AxeBuilder({ page }).include(".wed-toast").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations.map(v => v.id)).toEqual([]);
    state.failLoad = false;
    page.once("dialog", d => d.accept());
    await page.getByRole("button", { name: "Load latest draft" }).click();
    await expect(page.getByTestId("wed-strapline")).toHaveValue("Other editor's saved draft");
    await expect(page.getByTestId("wed-feedback")).toHaveCount(0);
    expect(state.writes).toHaveLength(count);
    await page.getByTestId("wed-strapline").fill("Reviewed combined wording");
    await page.clock.runFor(750);
    await expect(page.getByTestId("wed-save")).toContainText("Draft saved");
    expect(state.writes.at(-1)!.body.expected_draft_at).toBe(latestStamp);
    expect(JSON.parse(state.record.draft_json).strapline).toBe("Reviewed combined wording");
    expect(errors).toEqual([]); expect(remote.errors).toEqual([]);
    await other.close();
  });
}

for (const operation of ["publish", "discard"] as const) {
  test(`website editor conflict: stale ${operation} cannot clear another editor's draft`, async ({ page, context }) => {
    const { state, errors } = await mountEditor(page);
    const other = await context.newPage();
    await mountEditor(other, state);
    await other.getByTestId("wed-strapline").fill("Protected remote draft");
    await other.clock.runFor(750);
    await expect(other.getByTestId("wed-save")).toContainText("Draft saved");
    await page.getByTestId("wed-strapline").fill("Local unpublished change");
    if (operation === "discard") page.once("dialog", d => d.accept());
    await page.getByTestId(`wed-${operation}`).click();
    await expect(page.getByTestId("wed-save")).toHaveText("Draft conflict · paused");
    await expect(page.getByTestId("wed-strapline")).toHaveValue("Local unpublished change");
    expect(JSON.parse(state.record.draft_json).strapline).toBe("Protected remote draft");
    expect(state.record.version).toBe(0);
    expect(state.writes.map(w => w.kind)).toEqual(["draft", operation]);
    await page.clock.runFor(1500);
    expect(state.writes).toHaveLength(2);
    expect(errors).toEqual([]);
    await other.close();
  });
}

test("website editor conflict: an in-flight conflict cancels queued autosaves and publication", async ({ page, context }) => {
  const { state, errors } = await mountEditor(page);
  const other = await context.newPage();
  await mountEditor(other, state);
  let release!: () => void;
  state.holdDraft = new Promise<void>(resolve => { release = resolve; });
  await page.getByTestId("wed-strapline").fill("First local draft");
  await page.clock.runFor(750);
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByTestId("wed-strapline").fill("Latest local draft");
  await page.clock.runFor(750);
  await page.getByTestId("wed-publish").click();
  await expect(page.getByTestId("wed-close")).toBeDisabled();
  state.holdDraft = null;
  await other.getByTestId("wed-strapline").fill("Remote winner");
  await other.clock.runFor(750);
  await expect(other.getByTestId("wed-save")).toContainText("Draft saved");
  release();
  await expect(page.getByTestId("wed-save")).toHaveText("Draft conflict · paused");
  await expect(page.getByTestId("wed-strapline")).toHaveValue("Latest local draft");
  await page.clock.runFor(2000);
  expect(state.writes.map(write => write.kind)).toEqual(["draft", "draft"]);
  expect(JSON.parse(state.record.draft_json).strapline).toBe("Remote winner");
  expect(state.record.version).toBe(0);
  expect(errors).toEqual([]);
  await other.close();
});
