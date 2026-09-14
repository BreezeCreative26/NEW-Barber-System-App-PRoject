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

export async function section(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Workspace sections" })
    .getByRole("button", { name, exact: true })
    .click();
}
