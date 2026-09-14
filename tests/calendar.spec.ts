import { test, expect, request, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const origin = "http://localhost:3000";
const base = origin + "/api/sandbox";
function day(offset = 5) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function enter(page: Page) {
  await page.goto("/workspace");
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

test("day reads page deterministic ties, reject invalid queries and isolate tenants beyond the legacy 500 cap", async () => {
  test.setTimeout(90000);
  const a = await request.newContext({ extraHTTPHeaders: { Origin: origin } }),
    b = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  try {
    await a.post(base + "/session", {
      data: { name: "Calendar pagination audit" },
    });
    await b.post(base + "/session", { data: { name: "Other calendar shop" } });
    const w = await (await a.get(base + "/workspace")).json();
    const service = w.services.find((s: any) => s.duration_min === 30);
    const date = day();
    let first: any;
    let created = 0;
    fillBookings: for (let offset = 5; created < 503; offset++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + offset);
      if (d.getUTCDay() === 0) continue;
      for (const staff of w.staff)
        for (const start of [
          540, 585, 630, 675, 720, 810, 855, 900, 945, 990, 1035,
        ]) {
          const r = await a.post(base + "/bookings", {
            data: {
              request_id: crypto.randomUUID(),
              staff_id: staff.id,
              service_id: service.id,
              date: d.toISOString().slice(0, 10),
              start_min: start,
              customer_name: "Fictional calendar client",
              phone: "07700900123",
              source: "TEST_BOOKING",
              quote: {
                service_version: service.version,
                shop_version: w.shop.version,
              },
            },
          });
          expect(r.status(), await r.text()).toBe(201);
          first ??= (await r.json()).booking;
          created++;
          if (created === 503) break fillBookings;
        }
    }
    const before = await (await a.get(base + "/workspace")).json();
    expect(before.bookings.some((x: any) => x.id === first.id)).toBe(false);
    const ids: string[] = [];
    let cursor: any = null;
    do {
      const q = new URLSearchParams({
        date,
        limit: "3",
        ...(cursor
          ? {
              cursor_start: String(cursor.cursor_start),
              cursor_id: cursor.cursor_id,
            }
          : {}),
      });
      const p = await (await a.get(base + "/bookings?" + q)).json();
      expect(p.bookings.length).toBeLessThanOrEqual(3);
      ids.push(...p.bookings.map((x: any) => x.id));
      cursor = p.next_cursor;
    } while (cursor);
    expect(ids.length).toBe(22);
    expect(new Set(ids).size).toBe(22);
    expect(ids).toContain(first.id);
    expect(
      (await (await b.get(base + "/bookings?date=" + date)).json()).bookings,
    ).toEqual([]);
    expect((await a.get(base + "/bookings?date=2026-02-30")).status()).toBe(
      400,
    );
    expect(
      (await a.get(base + "/bookings?date=" + date + "&limit=10000")).status(),
    ).toBe(400);
    expect(
      (
        await a.get(base + "/bookings?date=" + date + "&cursor_start=1")
      ).status(),
    ).toBe(400);
    expect(
      (
        await a.get(base + "/bookings?date=" + date + "&shop_id=" + w.shop.id)
      ).status(),
    ).toBe(400);
    await a.post(base + `/staff/${first.staff_id}/days-off`, {
      data: { date, reason: "Fictional schedule impact" },
    });
    expect(
      (await (await a.get(base + "/workspace")).json()).issues.some(
        (i: any) => i.booking_id === first.id,
      ),
    ).toBe(true);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

test("timetable click prefills saved booking; reschedule and cancellation update the original-style calendar", async ({
  page,
}) => {
  await enter(page);
  await page.getByLabel("Appointment date", { exact: true }).fill(day());
  const cell = page.getByRole("button", {
    name: "09:00, Marcus Reed — add booking",
    exact: true,
  });
  await expect(cell).toBeEnabled();
  await cell.click();
  const w = await (await page.request.get(base + "/workspace")).json();
  expect(await page.getByLabel("Barber", { exact: true }).inputValue()).toBe(
    w.staff.find((s: any) => s.name === "Marcus Reed").id,
  );
  await expect(page.getByLabel("Available start time")).toHaveValue("540");
  await page
    .getByLabel("Fictional customer name")
    .fill("Calendar saved client");
  await page.getByLabel("Test UK mobile number").fill("07700900123");
  await page
    .getByRole("button", { name: "Review appointment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm test booking", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: /Calendar saved client,/ }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Appointment date", { exact: true }).fill(day());
  await page.getByRole("button", { name: /Calendar saved client,/ }).click();
  await page.getByRole("button", { name: "Reschedule", exact: true }).click();
  await page.getByLabel("Available start time").selectOption("600");
  await page
    .getByLabel("Reason for rescheduling")
    .fill("Customer requested another time");
  await page
    .getByRole("button", { name: "Review appointment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm reschedule", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Calendar saved client,.*10:00/ })
    .click();
  await page.getByLabel("Next status").selectOption("CANCELLED");
  await page
    .getByLabel("Reason / operational note")
    .fill("Customer cancellation");
  await page.getByRole("button", { name: "Update appointment status" }).click();
  await expect(
    page.getByRole("heading", { name: "Cancelled and no-show history" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "10:00, Marcus Reed — add booking",
      exact: true,
    }),
  ).toBeEnabled();
});

test("multiple pricing drafts survive individual save and dirty dismissal is explicit", async ({
  page,
}) => {
  await enter(page);
  await section(page, "Team");
  await page
    .getByRole("button", { name: "Services & pricing", exact: true })
    .first()
    .click();
  await page.getByLabel("Signature cut price override (£)").fill("33");
  await page.getByLabel("Skin fade price override (£)").fill("39");
  await page
    .getByRole("button", { name: "Save Signature cut rule", exact: true })
    .click();
  await expect(
    page.getByText("This service rule is saved. Other unsaved edits are kept."),
  ).toBeVisible();
  await expect(page.getByLabel("Skin fade price override (£)")).toHaveValue(
    "39",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("unsaved changes");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page
    .getByRole("button", { name: "Save Skin fade rule", exact: true })
    .click();
  await expect(
    page.getByText("This service rule is saved. Other unsaved edits are kept."),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Services & pricing", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Skin fade price override (£)")).toHaveValue(
    "39",
  );
  await page.getByLabel("Skin fade price override (£)").fill("50");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes and close" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("incomplete day or workspace responses have recovery without false empty calendar", async ({
  page,
}) => {
  await enter(page);
  await page.route("**/api/sandbox/bookings?**", (route) =>
    route.abort("failed"),
  );
  await page.getByLabel("Appointment date", { exact: true }).fill(day());
  await expect(
    page.getByRole("button", { name: "Retry workspace", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Saved appointment timetable" }),
  ).not.toBeVisible();
  await page.unroute("**/api/sandbox/bookings?**");
  await page
    .getByRole("button", { name: "Retry workspace", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Saved appointment timetable" }),
  ).toBeVisible();
  await page.route("**/api/sandbox/workspace", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), staff: null },
    });
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("incomplete");
  await expect(
    page.getByRole("button", { name: "Retry workspace", exact: true }),
  ).toBeVisible();
});

for (const width of [390, 1440])
  test(`connected timetable is accessible and usable at ${width}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    try {
      await enter(page);
      await page.getByLabel("Appointment date", { exact: true }).fill(day());
      await page
        .getByRole("button", { name: "Day timetable", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "09:00, Jay Carter — add booking",
          exact: true,
        }),
      ).toBeEnabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath(`calendar-${width}.png`),
        fullPage: true,
      });
      await page
        .getByRole("button", {
          name: "09:00, Jay Carter — add booking",
          exact: true,
        })
        .click();
      await expect(page.getByLabel("Available start time")).toHaveValue("540");
      await page.screenshot({
        path: test.info().outputPath(`slot-draft-${width}.png`),
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
