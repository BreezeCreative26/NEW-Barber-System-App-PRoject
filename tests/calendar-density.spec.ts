// Calendar density: Compact fits the whole working day on a laptop screen without vertical
// scrolling; the choice is saved per user (server prefs) and survives a reload; the shop default
// in Settings applies to people who never chose; the phone gets sane fixed sizes.
import { test, expect, request } from "@playwright/test";
import { base, origin, openFixtureShop, section } from "./fixture";
import { DENSITY_PRESETS, dayHeight } from "../src/client/calendarDensity";

test("presets: the geometry that makes Compact fit a 09:00–18:00 day into a 560px board", () => {
  expect(dayHeight(DENSITY_PRESETS.COMPACT, 9 * 60, 18 * 60)).toBeLessThanOrEqual(720);
  expect(DENSITY_PRESETS.COMPACT.step).toBeLessThan(DENSITY_PRESETS.STANDARD.step);
  expect(DENSITY_PRESETS.STANDARD.step).toBeLessThan(DENSITY_PRESETS.LARGE.step);
  expect(DENSITY_PRESETS.LARGE.step).toBe(44); // the original look survives as "Large"
});

test.describe("laptop 1366×768", () => {
  test.use({ viewport: { width: 1366, height: 768 } });
  test("Compact shows the whole day with no vertical scroll; Standard shows ≥ 4h; toolbar is one row; choice persists across reload and via the API", async ({ page }) => {
    await openFixtureShop(page, "owner");
    const board = page.locator(".connected-scroll");
    const toolbar = page.locator(".calendar-toolbar-row");
    // One toolbar row: the New booking button sits on the same line as Today.
    const today = await page.getByRole("button", { name: "Today", exact: true }).boundingBox();
    const add = await page.getByTestId("new-booking").boundingBox();
    expect(Math.abs((today?.y ?? 0) - (add?.y ?? 99))).toBeLessThan(4);
    expect((await toolbar.boundingBox())?.height ?? 999).toBeLessThan(64);

    const pick = async (d: string) => { await page.getByTestId("density-button").click(); await page.getByTestId(`density-${d}`).click(); await page.waitForTimeout(250); };
    await pick("compact");
    const compact = await board.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(compact.sh).toBeLessThanOrEqual(compact.ch + 1);
    expect(compact.ch).toBeGreaterThan(450);
    // Every appointment card is still readable: name + service visible on the one line.
    const first = page.locator(".calendar-event").first();
    await expect(first).toContainText(/\d\d:\d\d/);
    await expect(first.locator(".event-inline")).toBeVisible();

    await pick("standard");
    const std = await board.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, step: getComputedStyle(el.querySelector(".calendar-board") as HTMLElement).getPropertyValue("--step") }));
    expect(std.step.trim()).toBe("30px");
    // ≥ 4 hours visible: (client height − header) / (4 × 30px).
    expect((std.ch - 48) / 120).toBeGreaterThanOrEqual(4);
    expect(std.sh).toBeGreaterThan(std.ch);

    await pick("large");
    expect((await board.evaluate((el) => getComputedStyle(el.querySelector(".calendar-board") as HTMLElement).getPropertyValue("--step"))).trim()).toBe("44px");

    // Persisted for the user: reload → still Large; the server has it too.
    await page.reload();
    await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
    await expect(board).toHaveAttribute("data-density", "LARGE");
    await page.getByTestId("density-button").click();
    await expect(page.getByTestId("density-large")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    const me = await (await page.request.get(base + "/workspace")).json();
    expect(JSON.parse(me.account.prefs_json).calendar_density).toBe("LARGE");
    // Legend now lives inside the help popover, not as a permanent row.
    await expect(page.locator(".calendar-legend")).toBeHidden();
    await page.locator(".calendar-help summary").click();
    await expect(page.locator(".calendar-legend")).toBeVisible();
  });

  test("shop default from Settings applies to a user without a choice; a user's own choice wins", async ({ page }) => {
    const fx = await openFixtureShop(page, "owner");
    const r = await request.newContext({ extraHTTPHeaders: { Origin: origin }, storageState: await page.context().storageState() });
    const w = await (await r.get(base + "/workspace")).json();
    // Save the shop default via the settings form.
    await section(page, "Settings");
    await page.getByTestId("shop-calendar-density").selectOption("COMPACT");
    await page.getByRole("button", { name: /Save shop settings|Save settings|Save/ }).first().click();
    await page.waitForTimeout(400);
    const after = await (await r.get(base + "/workspace")).json();
    expect(after.shop.calendar_density).toBe("COMPACT");
    expect(after.shop.version).toBeGreaterThan(w.shop.version);
    // Jay (never chose) opens the calendar → compact; then chooses Large → Large despite the default.
    await page.request.post(base + "/auth/logout", { headers: { Origin: origin } });
    await page.evaluate(() => localStorage.removeItem("foliyo.prefs"));
    const login = await page.request.post(base + "/auth/login", { headers: { Origin: origin }, data: { email: `jay${fx.slug.slice(4)}@demo.test`, password: fx.password } });
    expect(login.status(), await login.text()).toBe(200);
    await page.goto("/workspace");
    await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
    await expect(page.locator(".connected-scroll")).toHaveAttribute("data-density", "COMPACT");
    await page.getByTestId("density-button").click();
    await page.getByTestId("density-large").click();
    await page.reload();
    await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
    await expect(page.locator(".connected-scroll")).toHaveAttribute("data-density", "LARGE");
  });
});

test.describe("phone 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("starts Compact with fixed 24px cells (no auto-squash), cards don't overlap, size menu opens as a sheet", async ({ page }) => {
    await openFixtureShop(page, "owner");
    const board = page.locator(".connected-scroll");
    await expect(board).toHaveAttribute("data-density", "COMPACT");
    expect((await board.evaluate((el) => getComputedStyle(el.querySelector(".calendar-board") as HTMLElement).getPropertyValue("--step"))).trim()).toBe("24px");
    // No two cards in the same column overlap vertically.
    const boxes = await page.locator(".calendar-event").evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), top: b.top, bottom: b.bottom }; }));
    for (const a of boxes) for (const b of boxes) if (a !== b && a.x === b.x) expect(a.top >= b.bottom || b.top >= a.bottom).toBe(true);
    // No horizontal page overflow.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByTestId("density-button").click();
    const menu = page.getByTestId("density-picker");
    await expect(menu).toBeVisible();
    await page.getByTestId("density-standard").click();
    expect((await board.evaluate((el) => getComputedStyle(el.querySelector(".calendar-board") as HTMLElement).getPropertyValue("--step"))).trim()).toBe("32px");
  });
});
