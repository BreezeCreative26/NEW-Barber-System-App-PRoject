import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openFixtureShop, origin, base, section, openFilters } from "./fixture";
import { enterNewShop } from "./shop";
test("initial network failure retries in place and unexpected HTML has a useful recovery message", async ({
  page,
}) => {
  const documentLoads: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "document") documentLoads.push(r.url());
  });
  await page.route("**/api/app/workspace", (r) => r.abort("failed"));
  await page.goto("/workspace");
  await expect(page.getByRole("alert")).toContainText(
    "Unable to reach the local workspace",
  );
  await expect(
    page.getByRole("button", { name: "Retry workspace" }),
  ).toBeVisible();
  await page.unroute("**/api/app/workspace");
  await page.route("**/api/app/workspace", (r) =>
    r.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<h1>Temporary proxy failure</h1>",
    }),
  );
  await page.getByRole("button", { name: "Retry workspace" }).click();
  await expect(page.getByRole("alert")).toContainText("unexpected response");
  await page.unroute("**/api/app/workspace");
  await page.getByRole("button", { name: "Retry workspace" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  expect(documentLoads).toHaveLength(1);
});

test("successful save followed by failed read recovers without repeating mutation or reloading", async ({
  page,
}) => {
  await enter(page);
  let writes = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/services") && r.method() === "POST") writes++;
  });
  await section(page, "Services");
  await page.getByRole("button", { name: "New service", exact: true }).click();
  await page.getByLabel("Service name").fill("Saved before network failure");
  await page.route("**/api/app/workspace", (r) => r.abort("failed"));
  await page.getByRole("button", { name: "Create service", exact: true }).click();
  await expect(
    page.getByTestId("service-editor").getByRole("status"),
  ).toContainText("Service created");
  await expect(page.getByRole("alert")).toContainText("Unable to reach");
  await page.unroute("**/api/app/workspace");
  await page.getByRole("button", { name: "Retry workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Saved before network failure" }),
  ).toBeVisible();
  expect(writes).toBe(1);
});

async function bookingDraft(page: Page, name = "Recovery test client") {
  const date = future();
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await page
    .getByLabel("Service", { exact: true })
    .selectOption({ label: "Signature cut" });
  await page.getByLabel("Available start time").selectOption("540");
  await page.getByLabel("Customer name", { exact: true }).fill(name);
  await page.getByLabel("Test UK mobile number").fill("07700900123");
  return date;
}

test("interrupted booking response retries idempotently and details/status filters persist", async ({
  page,
}) => {
  await enter(page);
  await bookingDraft(page);
  let intercepted = false;
  await page.route("**/api/app/bookings", async (route) => {
    if (!intercepted && route.request().method() === "POST") {
      intercepted = true;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "save response was interrupted",
  );
  await expect(page.getByLabel("Customer name", { exact: true })).toHaveValue(
    "Recovery test client",
  );
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  let w = await (await page.request.get("/api/app/workspace")).json();
  expect(w.bookings).toHaveLength(1);
  await page
    .getByRole("button")
    .filter({ hasText: "Recovery test client" })
    .click();
  await page
    .getByRole("button", { name: "Edit booking details", exact: true })
    .click();
  await page
    .getByLabel("Customer name", { exact: true })
    .fill("Updated recovery client");
  await page.getByLabel("Test notes").fill("Fictional preference");
  await page
    .getByLabel("Reason for detail changes")
    .fill("Corrected test record");
  await save(page);
  await expect(
    page.getByRole("button").filter({ hasText: "Updated recovery client" }),
  ).toBeVisible();
  await openFilters(page);
  await page.getByLabel("Status filter").selectOption("COMPLETED");
  await expect(
    page.getByRole("heading", { name: "No matching appointments" }),
  ).toBeVisible();
  await page.getByLabel("Status filter").selectOption("CONFIRMED");
  await expect(
    page.getByRole("button").filter({ hasText: "Updated recovery client" }),
  ).toBeVisible();
  w = await (await page.request.get("/api/app/workspace")).json();
  expect(w.bookings[0].notes).toBe("Fictional preference");
  expect(w.bookings[0].price_pence).toBe(2800);
});

test("availability network retry and stale quote refresh keep contact details", async ({
  page,
}) => {
  await enter(page);
  await page.getByLabel("Appointment date", { exact: true }).fill(future());
  await page.route("**/api/app/availability?**", (r) => r.abort("failed"));
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry availability" }),
  ).toBeVisible();
  await page.getByLabel("Customer name", { exact: true }).fill("Quote test client");
  await page.getByLabel("Test UK mobile number").fill("07700900123");
  await page.unroute("**/api/app/availability?**");
  await page.getByRole("button", { name: "Retry availability" }).click();
  await page
    .getByLabel("Service", { exact: true })
    .selectOption({ label: "Signature cut" });
  await page.getByLabel("Available start time").selectOption("540");
  await page.getByRole("button", { name: "Review appointment" }).click();
  const w = await (await page.request.get("/api/app/workspace")).json();
  const s = w.services.find(
    (s: { name: string }) => s.name === "Signature cut",
  );
  await page.request.put("/api/app/services/" + s.id, {
    headers: { Origin: "http://localhost:3000" },
    data: {
      name: s.name,
      category: s.category,
      duration_min: s.duration_min,
      price_pence: 3700,
      active: 1,
      version: s.version,
    },
  });
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "service or shop policy changed",
  );
  await expect(page.locator(".workspace-quote")).toContainText("£37");
  await expect(page.getByLabel("Customer name", { exact: true })).toHaveValue(
    "Quote test client",
  );
  await page.getByLabel("Available start time").selectOption("540");
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    (await (await page.request.get("/api/app/workspace")).json())
      .bookings[0].price_pence,
  ).toBe(3700);
});

test("stale editor can explicitly discard and load latest without page reload", async ({
  page,
}) => {
  await enter(page);
  await section(page, "Team");
  const w = await (await page.request.get("/api/app/workspace")).json();
  const s = w.staff[0];
  await page.getByTestId("team-card").filter({ hasText: s.name }).click();
  await page.getByLabel("Full name").fill("Unsaved edit");
  await page.request.put("/api/app/staff/" + s.id, {
    headers: { Origin: "http://localhost:3000" },
    data: {
      name: "Changed in another tab",
      role: s.role,
      active: 1,
      version: s.version,
    },
  });
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("record changed");
  await page
    .getByRole("button", { name: "Discard edits and load latest" })
    .click();
  await expect(page.getByLabel("Full name")).toHaveValue(
    "Changed in another tab",
  );
  await page.getByLabel("Full name").fill("Final test name");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.getByTestId("barber-editor").getByRole("status"),
  ).toContainText("Profile saved");
  await expect(
    page.getByRole("heading", { name: "Final test name" }),
  ).toBeVisible();
});
test("staff and service edits, inactive filters and reactivation survive refresh", async ({
  page,
}) => {
  await enter(page);
  for (const entry of [
    {
      tab: "Team",
      name: "Jay Carter",
      card: "team-card",
      editor: "barber-editor",
      checkbox: "Active and bookable",
      search: "Search team",
      save: "Save profile",
    },
    {
      tab: "Services",
      name: "Signature cut",
      card: "service-card",
      editor: "service-editor",
      checkbox: "Active",
      search: "Search services",
      save: "Save service",
    },
  ]) {
    await section(page, entry.tab);
    await page.getByLabel(entry.search).fill(entry.name);
    const card = page.getByTestId(entry.card).filter({ hasText: entry.name });
    await expect(card).toHaveCount(1);
    await card.click();
    await page.getByLabel(entry.checkbox, { exact: true }).uncheck();
    await page.getByRole("button", { name: entry.save, exact: true }).click();
    await expect(page.getByTestId(entry.editor).getByRole("status")).toContainText("saved");
    await expect(card).toHaveCount(0);
    await page.getByLabel("Show inactive").check();
    await expect(card).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(card).toContainText("Inactive");
    await page.getByLabel(entry.checkbox, { exact: true }).check();
    await page.getByRole("button", { name: entry.save, exact: true }).click();
    await expect(card).not.toContainText("Inactive");
    await page.getByLabel("Show inactive").uncheck();
    await expect(card).toBeVisible();
    await page.getByLabel(entry.search).fill("");
  }
});
test("dated staff leave survives reload, flags saved appointments and can be removed", async ({
  page,
}) => {
  await enter(page);
  const date = await bookingDraft(page, "Leave impact client");
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const w = await (await page.request.get("/api/app/workspace")).json();
  const barber = w.staff.find(
    (s: { id: string }) => s.id === w.bookings[0].staff_id,
  );
  await section(page, "Team");
  const card = page.getByTestId("team-card").filter({ hasText: barber.name });
  await card.click();
  await page
    .getByTestId("barber-editor")
    .getByRole("button", { name: "Schedule", exact: true })
    .click();
  await page.getByRole("button", { name: /^Days off/ }).click();
  await page.getByLabel("Day off date").fill(date);
  await page.getByLabel("Day off reason").fill("Fictional test leave");
  await page.getByRole("button", { name: "Save day off", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByText("Barber has a day off.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await section(page, "Team");
  await card.click();
  await page
    .getByTestId("barber-editor")
    .getByRole("button", { name: "Schedule", exact: true })
    .click();
  await page.getByRole("button", { name: /^Days off/ }).click();
  await expect(
    page.getByText("Fictional test leave", { exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "docs/evidence/staff-days-off.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: `Remove ${date}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm removal", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByText("Barber has a day off.", { exact: false }),
  ).not.toBeVisible();
  await section(page, "Appointments");
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await expect(
    page.getByRole("button").filter({ hasText: "Leave impact client" }),
  ).toBeVisible();
  const after = await (await page.request.get("/api/app/workspace")).json();
  expect(after.bookings).toHaveLength(1);
  expect(after.days_off).toHaveLength(0);
});
function future() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 4);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function enter(page: Page) {
  await enterNewShop(page, "Matte workflow test");
  await expect(
    page.getByRole("heading", { name: "No matching appointments" }),
  ).toBeVisible();
}
async function save(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

test("saved setup and appointment workflow survives reload, move and completion", async ({
  page,
}) => {
  await enter(page);
  await section(page, "Team");
  await page.getByRole("button", { name: "Add barber", exact: true }).click();
  await page.getByLabel("Full name").fill("Casey Test");
  await page.getByRole("button", { name: "Create barber", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Casey Test" })).toBeVisible();
  await page
    .getByTestId("barber-editor")
    .getByRole("button", { name: "Schedule", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit weekly hours" }).click();
  await page.getByLabel("Monday break start", { exact: true }).fill("12:00");
  await page.getByLabel("Monday break end", { exact: true }).fill("12:30");
  await save(page);
  await expect(page.getByRole("list", { name: "Weekly hours" })).toContainText("12:00");
  await section(page, "Services");
  await page.getByRole("button", { name: "New service", exact: true }).click();
  await page.getByLabel("Service name").fill("Test tidy-up");
  await page.getByLabel("Price (£)", { exact: true }).fill("19.50");
  await page.getByRole("button", { name: "Create service", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Test tidy-up" })).toBeVisible();
  await section(page, "Settings");
  await page
    .getByLabel("Shop name", { exact: true })
    .fill("Saved matte test shop");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.reload();
  await section(page, "Settings");
  await expect(page.getByLabel("Shop name", { exact: true })).toHaveValue(
    "Saved matte test shop",
  );
  await page.getByRole("button", { name: "Add closure", exact: true }).click();
  await page.getByLabel("Closure date").fill("2030-12-25");
  await page.getByLabel("Closure reason").fill("Christmas test closure");
  await save(page);
  await page.getByRole("button", { name: "Remove closure" }).click();
  await page.getByRole("button", { name: "Confirm removal" }).click();
  await expect(page.getByText("No dated closures.")).toBeVisible();
  await section(page, "Appointments");
  const day = future();
  await page.getByLabel("Appointment date", { exact: true }).fill(day);
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await page
    .getByLabel("Barber", { exact: true })
    .selectOption({ label: "Casey Test" });
  await page
    .getByLabel("Service", { exact: true })
    .selectOption({ label: "Test tidy-up" });
  await expect(page.getByLabel("Available start time")).toBeVisible();
  await page.getByLabel("Available start time").selectOption("540");
  await page.getByLabel("Customer name", { exact: true }).fill("Morgan Fictional");
  await page.getByLabel("Test UK mobile number").fill("07700 900123");
  await page.getByRole("button", { name: "Review appointment" }).click();
  await expect(
    page.getByText("Ready to save:", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button").filter({ hasText: "Morgan Fictional" }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Appointment date", { exact: true }).fill(day);
  await page
    .getByRole("button")
    .filter({ hasText: "Morgan Fictional" })
    .click();
  await page.getByRole("button", { name: "Reschedule", exact: true }).click();
  await page.getByLabel("Available start time").selectOption("900");
  await page
    .getByLabel("Reason for rescheduling")
    .fill("Client requested test move");
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.getByRole("button", { name: "Confirm reschedule" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button").filter({ hasText: "Morgan Fictional" }),
  ).toContainText("15:00");
  for (const status of ["CHECKED_IN", "IN_SERVICE", "COMPLETED"]) {
    await page
      .getByRole("button")
      .filter({ hasText: "Morgan Fictional" })
      .click();
    await page.getByLabel("Next status").selectOption(status);
    await page
      .getByRole("button", { name: "Update appointment status" })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  await expect(
    page.getByRole("button").filter({ hasText: "Morgan Fictional" }),
  ).toContainText("Completed");
  await section(page, "Audit");
  await expect(page.getByText("RESCHEDULED", { exact: true })).toBeVisible();
  await expect(page.getByText("COMPLETED", { exact: true })).toBeVisible();
});

test("failed mutation keeps entered form; retry works; offline does not imply saved", async ({
  page,
  context,
}) => {
  await enter(page);
  await section(page, "Services");
  await page.getByRole("button", { name: "New service", exact: true }).click();
  await page.getByLabel("Service name").fill("Preserved form");
  await page.route("**/api/app/services", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "Temporary database test error" }),
    }),
  );
  await page.getByRole("button", { name: "Create service", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Temporary database test error",
  );
  await expect(page.getByLabel("Service name")).toHaveValue("Preserved form");
  await page.unroute("**/api/app/services");
  await page.getByRole("button", { name: "Create service", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Preserved form" }),
  ).toBeVisible();
  await context.setOffline(true);
  await expect(
    page.getByText("Offline: this view may be stale.", { exact: false }),
  ).toBeVisible();
  await section(page, "Appointments");
  await expect(
    page.getByRole("button", { name: "New booking", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
});

for (const width of [320, 390, 768, 1024, 1440])
  test(`matte workspace layout and accessibility at ${width}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    await enter(page);
    for (const tab of [
      "Appointments",
      "Team",
      "Services",
      "Settings",
      "Audit",
    ]) {
      await section(page, tab);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
    }
    await section(page, "Appointments");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("evidence", `workspace-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "New booking", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("Available start time")).toBeVisible();
    const actionBox = await page
      .getByRole("button", { name: "Review appointment", exact: true })
      .boundingBox();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.y).toBeGreaterThanOrEqual(0);
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(888);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("evidence", `workspace-booking-${width}.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "New booking", exact: true }),
    ).toBeFocused();
    await context.close();
  });

test("insights tab renders period-scoped aggregates from saved records at desktop and phone widths", async ({
  page,
}) => {
  await enter(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 4);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  const date = d.toISOString().slice(0, 10);
  const service = w.services.find((s: any) => s.duration_min === 30);
  for (const start of [540, 600]) {
    const res = await page.request.post(base + "/bookings", {
      headers: { Origin: origin },
      data: {
        request_id: crypto.randomUUID(),
        staff_id: w.staff[0].id,
        service_id: service.id,
        date,
        start_min: start,
        customer_name: "Insight Client",
        phone: "07700900321",
        source: "TEST_BOOKING",
        quote: { service_version: service.version, shop_version: w.shop.version },
      },
    });
    expect(res.status(), await res.text()).toBe(201);
  }
  await section(page, "Insights");
  await expect(page.getByRole("heading", { name: "Shop insights" })).toBeVisible();
  const period = page.getByRole("group", { name: "Period" }).or(page.locator('.segmented[aria-label="Period"]'));
  await expect(period.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true");
  // Future test bookings count as upcoming value, not as period activity.
  const upcoming = page.locator(".stat-card", { hasText: "Upcoming" });
  await expect(upcoming.locator(".stat-value")).toHaveText("2");
  await expect(upcoming.locator(".stat-foot")).toContainText("booked ahead");
  await expect(page.locator(".stat-card", { hasText: "Appointments" }).first().locator(".stat-value")).toHaveText("0");
  await expect(page.getByRole("heading", { name: "Busiest times" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Appointments by weekday" }).locator("li")).toHaveCount(7);
  // Switching the period re-reads and keeps the pressed state in sync.
  await period.getByRole("button", { name: "Year" }).click();
  await expect(period.getByRole("button", { name: "Year" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/saved appointment records only/)).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("heading", { name: "Shop insights" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations, `axe at ${width}`).toEqual([]);
  }
});

test("appointment side panel: contextual actions, note, series ops, customer link; drawer on desktop, sheet on phone", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  // Book a fresh visit today at a free time so the panel has a CONFIRMED subject.
  const staff = w.staff[0];
  const service = w.services[0];
  const avail = await (await page.request.get(base + `/availability?date=${w.today}&staff_id=${staff.id}&service_id=${service.id}`)).json();
  const slot = avail.slots.find((s: any) => !s.reason);
  test.skip(!slot, "No free slot left today in the demo shop");
  const created = await page.request.post(base + "/bookings", {
    headers: { Origin: origin },
    data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: service.id, date: w.today, start_min: slot.start_min, customer_name: "Panel Client", phone: "07700900654", source: "WALK_IN", quote: avail.quote, addon_ids: [] },
  });
  expect(created.status(), await created.text()).toBe(201);
  const booking = (await created.json()).booking;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: /Panel Client/ }).first().click();
  const panel = page.getByTestId("appointment-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { level: 2 })).toContainText("Panel Client");
  await expect(panel.locator(".panel-timeline li")).toHaveCount(1);
  // Desktop: drawer on the right, calendar still visible behind.
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThan(700);
  await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
  // Add a note inline.
  await panel.getByRole("button", { name: "Add note" }).click();
  await panel.getByLabel("Appointment note").fill("Prefers a 2 on the sides");
  await panel.getByRole("button", { name: "Save note" }).click();
  await expect(panel.locator(".panel-notes p")).toContainText("Prefers a 2");
  await expect(panel.locator(".panel-timeline li")).toHaveCount(2);
  // Check in → Start → Complete via footer actions.
  await panel.getByRole("button", { name: "Check in" }).click();
  await expect(panel.getByText("Checked in", { exact: true }).first()).toBeVisible();
  await panel.getByRole("button", { name: "Start service" }).click();
  await panel.getByRole("button", { name: /^Complete/ }).click();
  await expect(panel.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "Book again" })).toBeVisible();
  // Customer card links through to the profile.
  await panel.getByRole("button", { name: /Profile/ }).click();
  await expect(page.getByTestId("customer-profile").getByRole("heading", { level: 2 })).toHaveText("Panel Client");
  await expect(page.locator(".customer-history li")).toHaveCount(1);
  // Standing series visit: cancel remaining from the panel.
  await page.getByRole("navigation", { name: "Workspace sections" }).getByRole("button", { name: "Appointments", exact: true }).click();
  const range = await (await page.request.get(base + `/bookings/range?from=${w.today}&to=${plusDays(w.today, 30)}`)).json();
  const seriesVisit = range.bookings.find((b: any) => b.series_id && b.status === "CONFIRMED");
  expect(seriesVisit).toBeTruthy();
  await page.getByLabel("Appointment date", { exact: true }).fill(seriesVisit.date);
  await page.getByRole("button", { name: new RegExp(seriesVisit.customer_name) }).first().click();
  await expect(panel.getByText("Standing", { exact: true })).toBeVisible();
  await expect(panel.locator(".series-strip li")).toHaveCount(5);
  await panel.getByRole("button", { name: "Cancel series" }).click();
  await panel.getByLabel("Reason (required)", { exact: true }).fill("Customer paused");
  await panel.getByRole("button", { name: "Cancel visits" }).click();
  await expect(panel.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  // Range reads are capped at 31 days; the series' remaining visits fall inside the next 30.
  const after = await (await page.request.get(base + `/bookings/range?from=${w.today}&to=${plusDays(w.today, 30)}`)).json();
  expect(after.bookings.filter((b: any) => b.series_id === seriesVisit.series_id && b.status === "CONFIRMED" && b.date >= seriesVisit.date).length).toBe(0);
  // Escape closes and focus returns.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  // Phone: bottom sheet, full width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await page.locator(".workspace-booking-row").first().click();
  await expect(panel).toBeVisible();
  const sheet = await panel.boundingBox();
  expect(sheet!.width).toBeGreaterThanOrEqual(380);
  expect(sheet!.y).toBeGreaterThan(20);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations).toEqual([]);
});

test("customers tab: filters, add customer with tags, profile stats, picker in booking form", async ({ page }) => {
  test.setTimeout(90000);
  await openFixtureShop(page);
  await section(page, "Customers");
  const list = page.getByTestId("customer-list");
  await expect(list.locator("li").first()).toBeVisible();
  const all = await list.locator("li").count();
  expect(all).toBeGreaterThan(20);
  await page.getByRole("button", { name: "Regulars", exact: true }).click();
  await expect.poll(async () => list.locator("li").count()).toBeLessThan(all);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search customers").fill("Ada");
  await expect.poll(async () => list.locator("li").count()).toBeLessThanOrEqual(3);
  await page.getByLabel("Search customers").fill("");
  // Add a customer with a tag.
  await page.getByRole("button", { name: "Add customer" }).click();
  await page.getByLabel("Full name").fill("Fresh Face");
  await page.getByLabel("Mobile number").fill("07700 900 321");
  await page.getByLabel("Add tag").fill("Student");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Add customer", exact: true }).last().click();
  const profile = page.getByTestId("customer-profile");
  await expect(profile.getByRole("heading", { level: 2 })).toHaveText("Fresh Face");
  await expect(profile.locator(".tag", { hasText: "Student" }).first()).toBeVisible();
  await expect(profile.locator(".stat-card").filter({ has: page.locator(".stat-label", { hasText: /^Visits/ }) }).locator(".stat-value")).toHaveText("0");
  // Open a regular's profile: stats and favourites are populated.
  await page.getByRole("button", { name: "All customers" }).click();
  await page.getByRole("button", { name: "Regulars", exact: true }).click();
  await expect(list.locator("li", { hasText: "Fresh Face" })).toHaveCount(0);
  await list.locator("li button").first().click();
  await expect(profile.locator(".customer-favourites strong").first()).not.toHaveText("Not yet");
  await expect(profile.locator(".customer-history li").first()).toBeVisible();
  const spend = await profile.locator(".stat-card", { hasText: "Lifetime spend" }).locator(".stat-value").innerText();
  expect(spend).toMatch(/^£\d+/);
  // Notes & tags tab saves.
  await page.getByRole("button", { name: "Notes & tags", exact: true }).click();
  await page.getByLabel(/Notes \(preferences/).fill("Allergic to menthol");
  await page.getByRole("button", { name: "Save notes & tags" }).click();
  await expect(page.getByRole("status").filter({ hasText: /saved|Saved/ }).or(page.getByLabel(/Notes \(preferences/))).toBeVisible();
  // New booking from the profile pre-picks the customer.
  await profile.getByRole("button", { name: "New booking" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("customer-picked")).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  if (await dialog.getByRole("button", { name: "Discard changes and close" }).isVisible().catch(() => false))
    await dialog.getByRole("button", { name: "Discard changes and close" }).click();
  await expect(dialog).toBeHidden();
  // Picker: search, arrow, enter picks; duplicate phone warns.
  await section(page, "Appointments");
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await dialog.getByLabel("Find customer").fill("Fresh");
  await expect(dialog.locator(".customer-picker-results button.active")).toContainText("Fresh Face");
  await dialog.getByLabel("Find customer").press("Enter");
  await expect(dialog.getByLabel("Customer name", { exact: true })).toHaveValue("Fresh Face");
  await expect(dialog.getByLabel("Test UK mobile number")).toHaveValue("07700900321");
  await expect(dialog.getByTestId("customer-picked")).toBeVisible();
  await dialog.getByRole("button", { name: "Book as someone else" }).click();
  await dialog.getByLabel("Customer name", { exact: true }).fill("Someone New");
  await dialog.getByLabel("Test UK mobile number").fill("07700900321");
  await expect(dialog.locator(".customer-duplicate")).toContainText("Fresh Face already has this number");
  await dialog.getByRole("button", { name: "use existing record" }).click();
  await expect(dialog.getByTestId("customer-picked")).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations).toEqual([]);
});
function plusDays(date: string, n: number) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test("service studio and barber studio: create with presentation flags, matrix from the service side, profile with skills, tabs, and the public page reflects it", async ({ page }) => {
  test.setTimeout(120000);
  const fixture = await openFixtureShop(page);

  // ---- Service studio ----
  await section(page, "Services");
  const serviceEditor = page.getByTestId("service-editor");
  await expect(page.getByTestId("service-card").first()).toBeVisible();
  await page.getByRole("button", { name: "New service", exact: true }).click();
  await page.getByLabel("Service name").fill("Studio hot towel finish");
  await serviceEditor.getByLabel("Category", { exact: true }).fill("Grooming");
  await page.getByLabel("Description (shown to customers online)").fill("Fictional finish with a hot towel.");
  await page.getByLabel("Duration (minutes)").fill("20");
  await page.getByLabel("Price (£)", { exact: true }).fill("14");
  await serviceEditor.getByRole("radio", { name: "Clay" }).check();
  await page.getByLabel("Popular", { exact: true }).check();
  await page.getByRole("button", { name: "Create service", exact: true }).click();
  await expect(serviceEditor.getByRole("status")).toContainText("Service created");
  await expect(serviceEditor.getByRole("heading", { level: 2 })).toHaveText("Studio hot towel finish");
  const card = page.getByTestId("service-card").filter({ hasText: "Studio hot towel finish" });
  await expect(card).toContainText("Popular");
  await expect(card).toHaveClass(/clay/);
  // Toggle online off and confirm the badge and persistence after reload.
  await page.getByLabel("Bookable online", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save service", exact: true }).click();
  await expect(serviceEditor.getByRole("status")).toContainText("Service saved");
  await expect(card).toContainText("In shop only");
  // Matrix from the service side: turn one barber off, price another, save once.
  await serviceEditor.getByRole("button", { name: "Barbers & pricing", exact: true }).click();
  const w = await (await page.request.get(base + "/workspace")).json();
  const [a, b] = w.staff.filter((s: { active: number }) => s.active);
  await page.getByLabel(`${a.name} offers Studio hot towel finish`).uncheck();
  await page.getByLabel(`${b.name} price for Studio hot towel finish`).fill("16");
  await expect(page.getByLabel(`${a.name} price for Studio hot towel finish`)).toBeDisabled();
  await page.getByRole("button", { name: "Save barber rules", exact: true }).click();
  await expect(serviceEditor.getByRole("status")).toContainText(/\d+ barber rules saved/);
  await page.reload();
  await section(page, "Services");
  await card.click();
  await serviceEditor.getByRole("button", { name: "Barbers & pricing", exact: true }).click();
  await expect(page.getByLabel(`${a.name} offers Studio hot towel finish`)).not.toBeChecked();
  await expect(page.getByLabel(`${b.name} price for Studio hot towel finish`)).toHaveValue("16");
  // Header summary reflects the matrix.
  await expect(serviceEditor.getByText(/of \d+ barbers/)).toBeVisible();
  // Guard: leaving with a dirty matrix requires an explicit choice.
  await page.getByLabel(`${b.name} price for Studio hot towel finish`).fill("18");
  await page.getByRole("button", { name: "All services", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("unsaved changes");
  await page.getByRole("button", { name: "Discard changes and continue", exact: true }).click();
  await expect(serviceEditor).toHaveCount(0);

  // ---- Barber studio ----
  await section(page, "Team");
  const barberEditor = page.getByTestId("barber-editor");
  await page.getByTestId("team-card").filter({ hasText: b.name }).click();
  await expect(barberEditor.getByRole("heading", { level: 2 })).toHaveText(b.name);
  await page.getByLabel("Job title (shown to customers)").fill("Studio test title");
  await page.getByLabel("Photo (upload or https URL)").fill("http://insecure.example/p.jpg");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(barberEditor.getByRole("alert")).toContainText(/https/i);
  await page.getByLabel("Photo (upload or https URL)").fill("");
  await page.getByLabel("Add skills").fill("Studio test skill");
  await page.getByLabel("Add skills").press("Enter");
  await expect(barberEditor.getByRole("button", { name: "Remove Studio test skill", exact: true })).toBeVisible();
  // Suggestions hide skills already present, so pick whichever suggestion remains.
  const suggestion = barberEditor.locator(".tag-suggestions button").first();
  const suggested = (await suggestion.textContent())!.replace(/^\+\s*/, "").trim();
  await suggestion.click();
  await expect(barberEditor.getByRole("button", { name: `Remove ${suggested}`, exact: true })).toBeVisible();
  await page.getByLabel("Instagram").fill("@studio.test");
  await barberEditor.getByRole("radio", { name: "Slate" }).check();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(barberEditor.getByRole("status")).toContainText("Profile saved");
  const teamCard = page.getByTestId("team-card").filter({ hasText: b.name });
  await expect(teamCard).toContainText("Studio test title");
  let saved = await (await page.request.get(base + "/workspace")).json();
  let skills: string[] = JSON.parse(saved.staff.find((s: { id: string }) => s.id === b.id).skills);
  expect(skills).toContain("Studio test skill");
  expect(skills).toContain(suggested);
  await page.getByRole("button", { name: `Remove ${suggested}`, exact: true }).click();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(barberEditor.getByRole("status")).toContainText("Profile saved");
  saved = await (await page.request.get(base + "/workspace")).json();
  skills = JSON.parse(saved.staff.find((s: { id: string }) => s.id === b.id).skills);
  expect(skills).not.toContain(suggested);
  expect(skills).toContain("Studio test skill");
  // Tabs: schedule strip + editors, services matrix from the barber side, performance, upcoming.
  await barberEditor.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByRole("list", { name: "Weekly hours" })).toBeVisible();
  await page.getByRole("button", { name: "Edit weekly hours" }).click();
  await expect(page.getByRole("dialog")).toContainText("weekly hours");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await barberEditor.getByRole("button", { name: "Services & pricing", exact: true }).click();
  await expect(page.getByLabel(`${b.name} price for Studio hot towel finish`)).toHaveValue("16");
  await barberEditor.getByRole("button", { name: "Performance", exact: true }).click();
  await expect(barberEditor.getByRole("group", { name: "Period" }).or(barberEditor.locator(".segmented[aria-label='Period']"))).toBeVisible();
  await expect(barberEditor.getByText(/completed|visits|no-show/i).first()).toBeVisible();
  await barberEditor.getByRole("button", { name: "Upcoming", exact: true }).click();
  await expect(barberEditor.getByRole("list", { name: "Upcoming appointments" })).toBeVisible();
  // Hide the barber online and check the public page.
  await barberEditor.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByLabel("Show on online booking", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(barberEditor.getByRole("status")).toContainText("Profile saved");
  await expect(teamCard).toContainText("Hidden online");

  // ---- Public page ----
  const shop = await (await page.request.get(origin + `/api/public/shops/${fixture.slug}`)).json();
  expect(shop.staff.map((s: { id: string }) => s.id)).not.toContain(b.id);
  expect(shop.services.map((s: { name: string }) => s.name)).not.toContain("Studio hot towel finish");
  await page.goto(`/book/${fixture.slug}`);
  await expect(page.getByText("Studio hot towel finish")).toHaveCount(0);
  await expect(page.getByText(b.name, { exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});
