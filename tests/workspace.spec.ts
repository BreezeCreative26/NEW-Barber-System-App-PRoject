import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("initial network failure retries in place and unexpected HTML has a useful recovery message", async ({
  page,
}) => {
  const documentLoads: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "document") documentLoads.push(r.url());
  });
  await page.route("**/api/sandbox/workspace", (r) => r.abort("failed"));
  await page.goto("/workspace");
  await expect(page.getByRole("alert")).toContainText(
    "Unable to reach the local workspace",
  );
  await expect(
    page.getByRole("button", { name: "Retry workspace" }),
  ).toBeVisible();
  await page.unroute("**/api/sandbox/workspace");
  await page.route("**/api/sandbox/workspace", (r) =>
    r.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<h1>Temporary proxy failure</h1>",
    }),
  );
  await page.getByRole("button", { name: "Retry workspace" }).click();
  await expect(page.getByRole("alert")).toContainText("unexpected response");
  await page.unroute("**/api/sandbox/workspace");
  await page.getByRole("button", { name: "Retry workspace" }).click();
  await expect(page.getByLabel("Test shop name")).toBeVisible();
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
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByLabel("Service name").fill("Saved before network failure");
  await page.route("**/api/sandbox/workspace", (r) => r.abort("failed"));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Saved successfully");
  await page.unroute("**/api/sandbox/workspace");
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
  await page.getByLabel("Fictional customer name").fill(name);
  await page.getByLabel("Test UK mobile number").fill("07700900123");
  return date;
}

test("interrupted booking response retries idempotently and details/status filters persist", async ({
  page,
}) => {
  await enter(page);
  await bookingDraft(page);
  let intercepted = false;
  await page.route("**/api/sandbox/bookings", async (route) => {
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
  await expect(page.getByLabel("Fictional customer name")).toHaveValue(
    "Recovery test client",
  );
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  let w = await (await page.request.get("/api/sandbox/workspace")).json();
  expect(w.bookings).toHaveLength(1);
  await page
    .getByRole("button")
    .filter({ hasText: "Recovery test client" })
    .click();
  await page
    .getByRole("button", { name: "Edit booking details", exact: true })
    .click();
  await page
    .getByLabel("Fictional customer name")
    .fill("Updated recovery client");
  await page.getByLabel("Test notes").fill("Fictional preference");
  await page
    .getByLabel("Reason for detail changes")
    .fill("Corrected test record");
  await save(page);
  await expect(
    page.getByRole("button").filter({ hasText: "Updated recovery client" }),
  ).toBeVisible();
  await page.getByLabel("Status filter").selectOption("COMPLETED");
  await expect(
    page.getByRole("heading", { name: "No matching appointments" }),
  ).toBeVisible();
  await page.getByLabel("Status filter").selectOption("CONFIRMED");
  await expect(
    page.getByRole("button").filter({ hasText: "Updated recovery client" }),
  ).toBeVisible();
  w = await (await page.request.get("/api/sandbox/workspace")).json();
  expect(w.bookings[0].notes).toBe("Fictional preference");
  expect(w.bookings[0].price_pence).toBe(2800);
});

test("availability network retry and stale quote refresh keep contact details", async ({
  page,
}) => {
  await enter(page);
  await page.getByLabel("Appointment date", { exact: true }).fill(future());
  await page.route("**/api/sandbox/availability?**", (r) => r.abort("failed"));
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry availability" }),
  ).toBeVisible();
  await page.getByLabel("Fictional customer name").fill("Quote test client");
  await page.getByLabel("Test UK mobile number").fill("07700900123");
  await page.unroute("**/api/sandbox/availability?**");
  await page.getByRole("button", { name: "Retry availability" }).click();
  await page
    .getByLabel("Service", { exact: true })
    .selectOption({ label: "Signature cut" });
  await page.getByLabel("Available start time").selectOption("540");
  await page.getByRole("button", { name: "Review appointment" }).click();
  const w = await (await page.request.get("/api/sandbox/workspace")).json();
  const s = w.services.find(
    (s: { name: string }) => s.name === "Signature cut",
  );
  await page.request.put("/api/sandbox/services/" + s.id, {
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
  await expect(page.getByLabel("Fictional customer name")).toHaveValue(
    "Quote test client",
  );
  await page.getByLabel("Available start time").selectOption("540");
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    (await (await page.request.get("/api/sandbox/workspace")).json())
      .bookings[0].price_pence,
  ).toBe(3700);
});

test("stale editor can explicitly discard and load latest without page reload", async ({
  page,
}) => {
  await enter(page);
  await section(page, "Team");
  const w = await (await page.request.get("/api/sandbox/workspace")).json();
  const s = w.staff[0];
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: s.name, exact: true }) })
    .getByRole("button", { name: "Edit barber", exact: true })
    .click();
  await page.getByLabel("Barber name").fill("Unsaved edit");
  await page.request.put("/api/sandbox/staff/" + s.id, {
    headers: { Origin: "http://localhost:3000" },
    data: {
      name: "Changed in another tab",
      role: s.role,
      active: 1,
      version: s.version,
    },
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("record changed");
  await page
    .getByRole("button", { name: "Discard edits and load latest" })
    .click();
  await expect(page.getByLabel("Barber name")).toHaveValue(
    "Changed in another tab",
  );
  await page.getByLabel("Barber name").fill("Final test name");
  await save(page);
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
      edit: "Edit barber",
      checkbox: "Active and bookable",
      search: "Search team",
    },
    {
      tab: "Services",
      name: "Signature cut",
      edit: "Edit service",
      checkbox: "Available for new bookings",
      search: "Search catalogue",
    },
  ]) {
    await section(page, entry.tab);
    await page.getByLabel(entry.search).fill(entry.name);
    const card = page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", { name: entry.name, exact: true }),
      });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: entry.edit, exact: true }).click();
    await page.getByLabel(entry.checkbox, { exact: true }).uncheck();
    await save(page);
    await page.getByLabel("Directory status").selectOption("1");
    await expect(card).toHaveCount(0);
    await page.getByLabel("Directory status").selectOption("0");
    await expect(card).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(card).toContainText("Inactive");
    await card.getByRole("button", { name: entry.edit, exact: true }).click();
    await page.getByLabel(entry.checkbox, { exact: true }).check();
    await save(page);
    await expect(card).toHaveCount(0);
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expect(card).toBeVisible();
  }
});
function future() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 4);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function enter(page: Page) {
  await page.goto("/workspace");
  await page.getByLabel("Test shop name").fill("Matte workflow test");
  await page
    .getByRole("button", { name: "Create test workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No matching appointments" }),
  ).toBeVisible();
}
async function section(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Workspace sections" })
    .getByRole("button", { name, exact: true })
    .click();
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
  await page.getByLabel("Barber name").fill("Casey Test");
  await save(page);
  await expect(page.getByRole("heading", { name: "Casey Test" })).toBeVisible();
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Casey Test" }) })
    .getByRole("button", { name: "Weekly hours" })
    .click();
  await page.getByLabel("Monday break start", { exact: true }).fill("12:00");
  await page.getByLabel("Monday break end", { exact: true }).fill("12:30");
  await save(page);
  await section(page, "Services");
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByLabel("Service name").fill("Test tidy-up");
  await page.getByLabel("Price (£)", { exact: true }).fill("19.50");
  await save(page);
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
  await page.getByLabel("Fictional customer name").fill("Morgan Fictional");
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
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByLabel("Service name").fill("Preserved form");
  await page.route("**/api/sandbox/services", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "Temporary database test error" }),
    }),
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Temporary database test error",
  );
  await expect(page.getByLabel("Service name")).toHaveValue("Preserved form");
  await page.unroute("**/api/sandbox/services");
  await save(page);
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
      path: `docs/evidence/workspace-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "New booking", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("Available start time")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: `docs/evidence/workspace-booking-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "New booking", exact: true }),
    ).toBeFocused();
    await context.close();
  });
