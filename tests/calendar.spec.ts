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

async function populateCalendar(page: Page) {
  const headers = { Origin: origin };
  const date = day();
  const bookings: any[] = [];
  for (const [index, duration] of [5, 15, 30, 60].entries()) {
    const created = await page.request.post(base + "/services", {
      headers,
      data: {
        name: `Fictional ${duration} minute service`,
        category: "Test services",
        duration_min: duration,
        price_pence: 2500,
      },
    });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id;
    const w = await (await page.request.get(base + "/workspace")).json();
    const service = w.services.find((s: any) => s.id === id);
    const result = await page.request.post(base + "/bookings", {
      headers,
      data: {
        request_id: crypto.randomUUID(),
        staff_id: w.staff[index % 2].id,
        service_id: id,
        date,
        start_min: [540, 540, 555, 570][index],
        customer_name: `${duration} minute fictional client with a deliberately long name`,
        phone: "07700900123",
        source: "TEST_BOOKING",
        quote: {
          service_version: service.version,
          shop_version: w.shop.version,
        },
      },
    });
    expect(result.status(), await result.text()).toBe(201);
    bookings.push((await result.json()).booking);
  }
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  await page
    .getByRole("button", { name: "Day timetable", exact: true })
    .click();
  await expect(page.locator(".calendar-event")).toHaveCount(4);
  return bookings;
}

test("E1 keyboard slot navigation skips bookings and breaks, restores focus and never reserves on movement", async ({
  page,
}) => {
  await enter(page);
  const bookings = await populateCalendar(page);
  const slots = page.locator('.timetable-slot[tabindex="0"]:enabled');
  await expect(slots).toHaveCount(2);
  const start = slots.first();
  await start.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".timetable-slot:focus")).toHaveAttribute(
    "data-minute",
    "615",
  );
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".timetable-slot:focus")).toHaveAttribute(
    "data-column",
    "1",
  );
  await expect(page.locator(".timetable-slot:focus")).toHaveAttribute(
    "data-minute",
    "645",
  );
  await page.keyboard.press("End");
  await expect(page.locator(".timetable-slot:focus")).toHaveAttribute(
    "data-minute",
    "1065",
  );
  await page.keyboard.press("Home");
  await expect(page.locator(".timetable-slot:focus")).toHaveAttribute(
    "data-minute",
    "645",
  );
  await page
    .locator('.timetable-slot[data-column="1"][data-minute="750"]')
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".timetable-slot:focus")).toHaveAttribute(
    "data-minute",
    "810",
  );
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".timetable-slot:focus")).toHaveAttribute(
    "data-minute",
    "750",
  );
  await page.keyboard.press("Home");
  const cell = page.locator(
    '.timetable-slot[data-column="1"][data-minute="645"]',
  );
  await expect(page.locator(".calendar-slot-context")).toContainText("10:45");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Available start time")).toHaveValue("645");
  await expect(page.getByLabel("Timetable starting point")).toContainText(
    "10:45",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(cell).toBeFocused();
  await expect(slots).toHaveCount(2);
  await page.keyboard.press("Tab");
  await expect(page.locator(".calendar-event").nth(2)).toBeFocused();
  const saved = await (
    await page.request.get(base + "/bookings?date=" + day())
  ).json();
  expect(saved.bookings.map((b: any) => b.id).sort()).toEqual(
    bookings.map((b) => b.id).sort(),
  );
});

test("E1 filters preserve barber colour and hidden occupancy; navigation keeps filters until explicitly cleared", async ({
  page,
}) => {
  await enter(page);
  const bookings = await populateCalendar(page);
  const event = page.getByRole("button", {
    name: /15 minute fictional client with/,
  });
  const colour = await event.getAttribute("class");
  await page.getByLabel("Barber filter").selectOption(bookings[1].staff_id);
  await expect(event).toHaveAttribute("class", colour!);
  await page.getByLabel("Search appointments").fill("not a saved customer");
  await expect(page.locator(".calendar-event")).toHaveCount(0);
  await expect(
    page.locator('.timetable-slot[data-minute="540"]'),
  ).toBeDisabled();
  await expect(page.locator(".calendar-buffer")).toHaveCount(2);
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await expect(page.getByLabel("Search appointments")).toHaveValue(
    "not a saved customer",
  );
  await page.getByRole("button", { name: "Next day", exact: true }).click();
  await expect(page.getByLabel("Barber filter")).toHaveValue(
    bookings[1].staff_id,
  );
  await page.getByRole("button", { name: "Previous day", exact: true }).click();
  await expect(
    page.getByLabel("Appointment date", { exact: true }),
  ).toHaveValue(day());
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(page.getByLabel("Barber filter")).toHaveValue("");
  await expect(page.getByLabel("Search appointments")).toHaveValue("");
  await page.getByLabel("Status filter").selectOption("CANCELLED");
  await expect(
    page.getByRole("heading", { name: "No matching appointments" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const w = await (await page.request.get(base + "/workspace")).json();
  await expect(
    page.getByLabel("Appointment date", { exact: true }),
  ).toHaveValue(w.today);
});

test("E1 unavailable chair time distinguishes past, leave, breaks and shop closure", async ({
  page,
}) => {
  await enter(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  await page.getByLabel("Appointment date", { exact: true }).fill(day(-2));
  await expect(page.locator(".timetable-slot:enabled")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /09:00,.*Past time/ }),
  ).toHaveCount(2);
  const result = await page.request.post(
    base + `/staff/${w.staff[0].id}/days-off`,
    {
      headers: { Origin: origin },
      data: { date: day(), reason: "Fictional E1 leave" },
    },
  );
  expect(result.status()).toBe(201);
  await page.getByLabel("Appointment date", { exact: true }).fill(day());
  await expect(
    page.locator('.timetable-slot[data-column="0"]:enabled'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /09:00,.*Day off/ }),
  ).toHaveCount(1);
  await expect(page.getByRole("button", { name: /12:45,.*Break/ })).toHaveCount(
    1,
  );
  const closure = await page.request.post(base + "/holidays", {
    headers: { Origin: origin },
    data: { date: day(), label: "Fictional E1 closure" },
  });
  expect(closure.status(), await closure.text()).toBe(201);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".timetable-slot:enabled")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /09:00,.*Shop closed/ }),
  ).toHaveCount(2);
});

for (const width of [320, 390, 768, 1024, 1440])
  test(`E1 populated calendar long and short cards at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await enter(page);
    await populateCalendar(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await expect(page.locator(".calendar-legend")).toContainText("Buffer");
    await expect(page.locator(".calendar-buffer")).toHaveCount(4);
    await expect(page.locator(".calendar-event.compact-event")).toHaveCount(1);
    expect(
      await page.locator(".calendar-event").evaluateAll((events) =>
        events.every((e) => {
          return Array.from(e.children).every(
            (child) =>
              child.getBoundingClientRect().bottom <=
              e.getBoundingClientRect().bottom + 1,
          );
        }),
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page
      .getByRole("heading", { name: "Your timetable", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath(`e1-calendar-${width}.png`),
      fullPage: true,
    });
    // Exercise CSS 200% zoom reflow (not a physical-browser zoom certification).
    if (width === 1440) {
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page
        .getByRole("button", { name: "New booking", exact: true })
        .click();
      await expect(page.getByLabel("Available start time")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        document.documentElement.style.zoom = "";
      });
    }
    await page.getByRole("button", { name: "Agenda", exact: true }).click();
    await page.screenshot({
      path: test.info().outputPath(`e1-agenda-${width}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
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
