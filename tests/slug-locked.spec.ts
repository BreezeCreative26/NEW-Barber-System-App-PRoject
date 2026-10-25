// The shop's web address is chosen at signup and never changes afterwards.
import { test, expect, request } from "@playwright/test";
const origin = "http://localhost:3000";
const base = origin + "/api/app";

test("address set at signup is fixed: the API refuses a change and the setup step shows it as plain text", async ({ page }) => {
  const slug = `lock-${crypto.randomUUID().slice(0, 8)}`;
  const res = await page.request.post(base + "/auth/signup", {
    headers: { Origin: origin },
    data: { shop_name: "Locked Cuts", slug, name: "Lee Owner", email: `lock-${Date.now()}@example.com`, password: "Passw0rd!passw0rd", accept_legal: true, kind: "BARBER" },
  });
  expect(res.status(), await res.text()).toBe(201);
  expect((await res.json()).slug).toBe(slug);
  const w = await (await page.request.get(base + "/workspace")).json();
  expect(w.shop.slug).toBe(slug);

  // Trying to move it is refused, whatever the new value.
  const moved = await page.request.put(base + "/shop/online", { headers: { Origin: origin }, data: { slug: `${slug}-new`, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } });
  expect(moved.status()).toBe(409);
  expect((await moved.json()).message ?? (await moved.json()).error).toMatch(/fixed|address/i);
  const after = await (await page.request.get(base + "/workspace")).json();
  expect(after.shop.slug).toBe(slug);

  // Saving the other online-booking settings with the same address still works.
  const same = await page.request.put(base + "/shop/online", { headers: { Origin: origin }, data: { slug, online_booking: 0, lead_time_min: 120, booking_window_days: 28, version: after.shop.version } });
  expect(same.status(), await same.text()).toBe(200);

  // Setup, go-live step: the address is shown, not editable.
  await page.goto(origin + "/workspace/setup");
  await expect(page.getByTestId("setup-wizard")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /^Go live/ }).click();
  await expect(page.getByTestId("setup-slug-fixed")).toBeVisible();
  await expect(page.getByTestId("setup-slug")).toContainText(slug);
  await expect(page.getByTestId("setup-slug-fixed").locator("input")).toHaveCount(0);

  // Settings → Online booking: the field is read-only.
  await page.goto(origin + "/workspace#settings/online");
  const field = page.getByTestId("online-slug");
  if (await field.count()) { await expect(field).toHaveAttribute("readonly", ""); await expect(field).toHaveValue(slug); }
});
