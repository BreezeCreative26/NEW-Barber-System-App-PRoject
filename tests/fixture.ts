// Shared helpers for browser tests that need a fully seeded shop.
// `openFixtureShop` builds a private copy of the demo seed (own slug/emails) and signs the
// page in as its owner, so tests never fight over the shared demo shop and can run in parallel.
import { expect, type Page } from "@playwright/test";

export const origin = "http://localhost:3000";
export const base = origin + "/api/sandbox";

export type Fixture = { shop_id: string; slug: string; email: string };

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
export async function section(page: Page, name: string) {
  const nav = page.getByRole("navigation", { name: "Workspace sections" });
  for (const label of [name, PHONE_ALIAS[name]].filter(Boolean) as string[]) {
    const direct = nav.getByRole("button", { name: label, exact: true });
    if (await direct.count()) {
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
