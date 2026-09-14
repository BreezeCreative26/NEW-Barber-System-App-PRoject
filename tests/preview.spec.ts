import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function ready(page: Page, route: string) {
  await page.goto(`/preview/${route}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function audit(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  ).toEqual([]);
}

for (const width of [320, 390, 768, 1024, 1440]) {
  for (const route of ["admin", "book", "barber"]) {
    test(`${route} layout at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await ready(page, route);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `docs/evidence/${route}-${width}.png`,
        fullPage: true,
      });
      expect(errors).toEqual([]);
      if ([390, 1440].includes(width)) await audit(page);
    });
  }
}

test("admin date navigation, search, barber filters and agenda work", async ({
  page,
}) => {
  await ready(page, "admin");
  await expect(page.locator(".calendar-event")).toHaveCount(18);
  await page
    .getByRole("combobox", { name: "Filter calendar by barber" })
    .selectOption("jay");
  await expect(page.locator(".calendar-event")).toHaveCount(5);
  await page
    .getByRole("textbox", { name: "Search sample appointments" })
    .fill("James");
  await expect(page.locator(".calendar-event")).toHaveCount(1);
  await page
    .getByRole("button", { name: /James Anderson, Signature cut/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(
    "No real booking or payment exists",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /James Anderson, Signature cut/ }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Clear appointment search" }).click();
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await expect(page.locator(".agenda-row")).toHaveCount(5);
  await page.getByRole("button", { name: "Next day", exact: true }).click();
  await expect(page.locator(".date-controls h2")).toHaveText(
    "15 September 2026",
  );
  await page.getByRole("button", { name: "Previous day", exact: true }).click();
  await expect(page.locator(".date-controls h2")).toHaveText(
    "14 September 2026",
  );
  await page
    .getByRole("button", { name: "Sunday 20 September", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A clear calendar" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset calendar" }).click();
  await expect(page.locator(".agenda-row")).toHaveCount(18);
});

test("admin directories, booking draft validation and no-persistence boundary", async ({
  page,
}) => {
  await ready(page, "admin");
  const mutations: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") mutations.push(r.url());
  });
  await page.getByRole("button", { name: /Team directory/ }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Jay Carter" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Service menu" }).click();
  await expect(page.getByRole("dialog")).toContainText("Hot towel finish");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await page.getByRole("button", { name: "Review draft" }).click();
  await expect(
    page.getByText("Enter a name with at least 2 characters."),
  ).toBeVisible();
  await expect(page.getByPlaceholder("e.g. Jamie Taylor")).toBeFocused();
  await page
    .getByPlaceholder("e.g. Jamie Taylor")
    .fill("Alexandra Montgomery-Wellington");
  await page.getByPlaceholder("07700 900123").fill("07700 900123");
  await page.getByLabel("Sample start time").selectOption("990");
  await page.getByRole("button", { name: "Review draft" }).click();
  await expect(
    page.getByRole("heading", { name: "Draft review" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(
    "No appointment was saved",
  );
  await page.getByRole("button", { name: "Edit draft" }).click();
  await expect(page.getByPlaceholder("e.g. Jamie Taylor")).toHaveValue(
    "Alexandra Montgomery-Wellington",
  );
  await audit(page);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".calendar-event")).toHaveCount(18);
  expect(mutations).toEqual([]);
});

test("customer service filters and extras update quote", async ({ page }) => {
  await ready(page, "book");
  await page
    .getByRole("textbox", { name: "Search services" })
    .fill("not a service");
  await expect(
    page.getByRole("heading", { name: "No services found" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("button", { name: "Beard", exact: true }).click();
  await expect(page.locator(".service-choice")).toHaveCount(1);
  await page.getByRole("button", { name: "All services", exact: true }).click();
  await page.getByRole("button", { name: /^Skin fade/ }).click();
  await page.getByLabel(/Hot towel finish/).check();
  await expect(page.locator(".summary-price > p").first()).toContainText("£39");
  await expect(page.locator(".summary-appointment")).toContainText(
    "55 minutes",
  );
  await page.getByRole("button", { name: "Choose your barber" }).click();
  await page.getByRole("button", { name: /Marcus Reed/ }).click();
  await expect(page.locator(".summary-price > p").first()).toContainText("£36");
  await audit(page);
});

test("customer journey validates data, preserves edits and never collects payment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, "book");
  const mutations: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") mutations.push(r.url());
  });
  const sticky = await page.locator(".booking-actions").boundingBox();
  expect(sticky!.y + sticky!.height).toBeLessThanOrEqual(845);
  await page.getByRole("button", { name: "Choose your barber" }).click();
  await page.getByRole("button", { name: "Find a time" }).click();
  await expect(
    page.getByRole("button", { name: "Your details", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /Sunday 20 September/ }).click();
  await expect(
    page.getByText("No sample slots on this date. Try another day."),
  ).toBeVisible();
  await page.getByRole("button", { name: /Tuesday 15 September/ }).click();
  await page.getByRole("button", { name: "Afternoon", exact: true }).click();
  await page
    .getByRole("button", { name: "16:30, available sample time" })
    .click();
  await audit(page);
  await page.getByRole("button", { name: "Your details", exact: true }).click();
  await page
    .getByRole("button", { name: "Review appointment", exact: true })
    .click();
  await expect(
    page.getByText("Enter a name with at least 2 characters."),
  ).toBeVisible();
  await page.getByLabel("Your name", { exact: true }).fill("Jamie Taylor");
  await page
    .getByLabel("Mobile number", { exact: true })
    .fill("+44 7700 900123");
  await page
    .getByLabel("Email address (optional)", { exact: true })
    .fill("jamie@example.com");
  await page
    .getByRole("button", { name: "Review appointment", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your next good hair day." }),
  ).toBeVisible();
  await expect(page.getByText("Payments are not connected.")).toBeVisible();
  await page.getByLabel("Save my card for next time", { exact: false }).check();
  await page.getByRole("button", { name: "View payment next step" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "cannot collect a card, hold a slot or create a booking",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Your name", { exact: true })).toHaveValue(
    "Jamie Taylor",
  );
  expect(mutations).toEqual([]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "What are we doing today?" }),
  ).toBeVisible();
});

test("barber tabs, queue detail and payment calculator have honest boundaries", async ({
  page,
}) => {
  await ready(page, "barber");
  await expect(page.locator(".queue-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Completed", exact: true }).click();
  await expect(page.locator(".queue-row")).toHaveCount(1);
  await page.locator(".queue-row").click();
  await expect(page.getByRole("dialog")).toContainText("Oliver Wilson");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Explore payment screen" }).click();
  await expect(page.getByTestId("payment-total")).toHaveText("£37");
  await page.getByRole("button", { name: "10%", exact: true }).click();
  await expect(page.getByTestId("payment-total")).toHaveText("£41.20");
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByLabel("Custom tip (£)").fill("5.50");
  await expect(page.getByTestId("payment-total")).toHaveText("£42.50");
  await page.getByLabel("Custom tip (£)").fill("-1");
  await expect(
    page.getByRole("button", { name: "Explain card step" }),
  ).toBeDisabled();
  await page.getByLabel("Custom tip (£)").fill("5");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Explain cash step" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "No cash receipt has been recorded.",
  );
  await audit(page);
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  await page.getByRole("button", { name: "Earnings", exact: true }).click();
  await expect(
    page.getByText("Your shop owner pays you directly."),
  ).toBeVisible();
  await audit(page);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Jay Carter", exact: true }),
  ).toBeVisible();
});

for (const route of ["admin", "book", "barber"]) {
  test(`${route} loading empty error offline scenarios recover`, async ({
    page,
  }) => {
    await ready(page, route);
    const scenario = page.getByRole("combobox", { name: "Preview state" });
    await scenario.selectOption("loading");
    await expect(
      page.getByRole("heading", { name: "Getting your day ready" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Return to preview" }).click();
    await scenario.selectOption("empty");
    await expect(
      page.getByRole("heading", { name: "A little room for something new" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show sample data" }).click();
    await scenario.selectOption("error");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(scenario).toHaveValue("normal");
    await scenario.selectOption("offline");
    await expect(page.getByText("Offline-state preview.")).toBeVisible();
    await scenario.selectOption("normal");
    await page.context().setOffline(true);
    await expect(page.getByText(/Your device is offline/)).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.getByText(/Your device is offline/)).toHaveCount(0);
  });
}

test("mobile navigation traps focus, closes with Escape and opens the directories", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, "admin");
  await expect(page.locator(".agenda-row")).toHaveCount(18);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Preview information", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".brand-link")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open navigation", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: /Team directory/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".sidebar")).toBeHidden();
});

test("dialog keyboard trap and 200 percent equivalent layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 450 });
  await ready(page, "admin");
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Review draft" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "New booking", exact: true }),
  ).toBeFocused();
});
