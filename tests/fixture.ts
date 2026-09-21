// Shared helpers for browser tests that need a fully seeded shop.
// `openFixtureShop` builds a private copy of the demo seed (own slug/emails) and signs the
// page in as its owner, so tests never fight over the shared demo shop and can run in parallel.
import { expect, type Page } from "@playwright/test";

export const origin = "http://localhost:3000";
export const base = origin + "/api/app";

export type Fixture = { shop_id: string; slug: string; email: string; password: string };

export async function openFixtureShop(page: Page, as: "owner" | "barber" = "owner"): Promise<Fixture> {
  const res = await page.request.post(base + "/auth/demo", {
    headers: { Origin: origin },
    data: { fixture: true, as },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as Fixture;
  await page.goto("/workspace");
  await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
  return body;
}

// Phone tab bar labels the calendar "Today"; desktop rail labels it "Appointments".
const PHONE_ALIAS: Record<string, string> = { Appointments: "Today" };
// Settings is tabbed; "Settings" alone opens General. Use "Settings/booking", "Settings/page",
// "Settings/messages" or "Settings/payments" to land on a sub-tab.
export async function section(page: Page, name: string) {
  let settingsTab = "";
  if (name.startsWith("Settings/")) { settingsTab = name.slice(9); name = "Settings"; }
  await sectionNav(page, name);
  if (settingsTab) await page.getByTestId(`settings-tab-${settingsTab}`).click();
}
async function sectionNav(page: Page, name: string) {
  const nav = page.getByRole("navigation", { name: "Workspace sections" });
  // The rail is rebuilt once the workspace (and the signed-in role) has loaded; give it a beat
  // before deciding the section lives behind the phone "More" sheet.
  await nav.getByRole("button").first().waitFor();
  for (const label of [name, PHONE_ALIAS[name]].filter(Boolean) as string[]) {
    const direct = nav.getByRole("button", { name: label, exact: true });
    if (await direct.count() || (await direct.waitFor({ timeout: 1500 }).then(() => true, () => false))) {
      await direct.click();
      return;
    }
  }
  // Phone: remaining sections live behind the More sheet.
  await nav.getByTestId("tab-more").click();
  await nav.getByRole("menuitem", { name, exact: true }).click();
}

// Status / search filters live behind the toolbar "Filters" toggle; idempotent.
export async function openFilters(page: Page) {
  const toggle = page.getByTestId("filters-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByLabel("Status filter")).toBeVisible();
}

// Schedule issues and the waitlist live in the notifications drawer behind the bell.
export async function openNotifications(page: Page) {
  const bell = page.getByTestId("bell");
  if ((await bell.getAttribute("aria-expanded")) !== "true") await bell.click();
  await expect(page.getByTestId("notifications")).toBeVisible();
}

// The waiting list (queue) drawer lives behind the hourglass chip in the top bar.
export async function openQueue(page: Page) {
  const chip = page.getByTestId("queue-chip");
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
  await expect(page.getByTestId("queue-drawer")).toBeVisible();
}

// The workspace has no Refresh button: it re-reads on window focus (and every 60s). Tests trigger
// that path explicitly and wait for the load to settle.
export async function refreshView(page: Page) {
  const done = page.waitForResponse((r) => r.url().includes("/api/app/workspace") && r.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await done;
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

// Complete a visit from the appointment panel without taking money. With till access the footer
// shows "Checkout" and completion lives in the ⋯ menu; without it the footer shows "Mark done".
export async function markDone(page: Page) {
  const panel = page.getByTestId("appointment-panel");
  const direct = panel.getByRole("button", { name: "Mark done", exact: true });
  if (await direct.count()) await direct.click();
  else {
    await panel.locator(".panel-more summary").click();
    await panel.getByRole("button", { name: "Mark done without payment", exact: true }).click();
  }
  await expect(panel.getByText("Completed", { exact: true }).first()).toBeVisible();
}
