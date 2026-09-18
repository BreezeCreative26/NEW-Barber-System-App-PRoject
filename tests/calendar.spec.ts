import { test, expect, request, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { section, openFilters, openFixtureShop } from "./fixture";
import { base, origin, signup, seedCatalogue, enterNewShop } from "./shop";
import { refreshView } from "./fixture";
function day(offset = 5) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function enter(page: Page) {
  await enterNewShop(page, "Calendar UI shop");
  await expect(
    page.getByRole("heading", { name: "No matching appointments" }),
  ).toBeVisible();
}

test("day reads page deterministic ties, reject invalid queries and isolate tenants beyond the legacy 500 cap", async () => {
  test.setTimeout(90000);
  const a = await request.newContext({ extraHTTPHeaders: { Origin: origin } }),
    b = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  try {
    await signup(a, "Calendar pagination audit");
    await seedCatalogue(a);
    await signup(b, "Other calendar shop");
    await seedCatalogue(b);
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
    .getByLabel("Customer name", { exact: true })
    .fill("Calendar saved client");
  await page.getByLabel("Mobile number", { exact: true }).fill("07700900123");
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
  const panel = page.getByTestId("appointment-panel");
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await panel.getByLabel("Reason (required)", { exact: true }).fill("Customer cancellation");
  await panel.getByRole("button", { name: "Confirm cancelled", exact: true }).click();
  await expect(panel).toContainText("Cancelled");
  await page.keyboard.press("Escape");
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

test("barber rule matrix: multi-row draft saves together, revert is explicit and leaving with edits is guarded", async ({
  page,
}) => {
  await enter(page);
  await section(page, "Team");
  const editor = page.getByTestId("barber-editor");
  await page.getByTestId("team-card").first().click();
  const barber = (await editor.getByRole("heading", { level: 2 }).textContent())!.trim();
  await editor
    .getByRole("button", { name: "Services & pricing", exact: true })
    .click();
  await page.getByLabel(`${barber} price for Signature cut`).fill("33");
  await page.getByLabel(`${barber} price for Skin fade`).fill("39");
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(page.getByLabel(`${barber} price for Skin fade`)).toHaveValue("");
  await page.getByLabel(`${barber} price for Signature cut`).fill("33");
  await page.getByLabel(`${barber} price for Skin fade`).fill("39");
  await page
    .getByRole("button", { name: "Save barber rules", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText("saved");
  await page.reload();
  await section(page, "Team");
  await page.getByTestId("team-card").first().click();
  await editor
    .getByRole("button", { name: "Services & pricing", exact: true })
    .click();
  await expect(page.getByLabel(`${barber} price for Skin fade`)).toHaveValue("39");
  await expect(page.getByLabel(`${barber} price for Signature cut`)).toHaveValue("33");
  await page.getByLabel(`${barber} price for Skin fade`).fill("50");
  await editor.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("unsaved changes");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel(`${barber} price for Skin fade`)).toHaveValue("50");
  await page.getByRole("button", { name: "All barbers", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes and continue", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  const w = await (await page.request.get("/api/app/workspace")).json();
  const fade = w.services.find((s: { name: string }) => s.name === "Skin fade");
  const who = w.staff.find((s: { name: string }) => s.name === barber);
  expect(
    w.service_rules.find(
      (r: { service_id: string; staff_id: string }) =>
        r.service_id === fade.id && r.staff_id === who.id,
    ).price_pence,
  ).toBe(3900);
});

test("incomplete day or workspace responses have recovery without false empty calendar", async ({
  page,
}) => {
  await enter(page);
  await page.route("**/api/app/bookings?**", (route) =>
    route.abort("failed"),
  );
  await page.getByLabel("Appointment date", { exact: true }).fill(day());
  await expect(
    page.getByRole("button", { name: "Retry workspace", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Saved appointment timetable" }),
  ).not.toBeVisible();
  await page.unroute("**/api/app/bookings?**");
  await page
    .getByRole("button", { name: "Retry workspace", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Saved appointment timetable" }),
  ).toBeVisible();
  await page.route("**/api/app/workspace", async (route) => {
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
  await openFilters(page);
  await page.getByLabel("Search appointments").fill("not a saved customer");
  await expect(page.locator(".calendar-event")).toHaveCount(0);
  // Hidden occupancy stays visible as "Occupied" cells; since the Fresha-style calendar they remain
  // clickable (book alongside) rather than disabled.
  await expect(page.locator('.timetable-slot[data-minute="540"]')).toHaveClass(/occupied/);
  await expect(page.locator('.timetable-slot[data-minute="540"]').first()).toHaveAttribute("title", /Occupied/);
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
  // A day off hides the barber from the scheduled team by default; add them back to see the greyed column.
  await page.getByTestId("team-picker").click();
  await page.getByRole("dialog", { name: "Scheduled team" }).getByLabel(new RegExp(w.staff[0].name)).check();
  await page.getByRole("dialog", { name: "Scheduled team" }).getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog", { name: "Scheduled team" })).toHaveCount(0);
  await expect(
    page.locator('.timetable-slot[data-column="0"]:enabled'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /09:00,.*Day off/ }),
  ).toHaveCount(1);
  // Breaks are greyed but clickable (book anyway), so they are enabled buttons.
  await expect(page.getByRole("button", { name: /12:45,.*Break/ })).toHaveCount(
    1,
  );
  await expect(page.getByRole("button", { name: /12:45,.*Break/ })).toBeEnabled();
  const closure = await page.request.post(base + "/holidays", {
    headers: { Origin: origin },
    data: { date: day(), label: "Fictional E1 closure" },
  });
  expect(closure.status(), await closure.text()).toBe(201);
  await refreshView(page);
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
          // The resize grip hugs the bottom edge; everything else must stay inside the card.
          return Array.from(e.children)
            .filter((child) => !child.classList.contains("resize-handle"))
            .every(
              (child) =>
                child.getBoundingClientRect().bottom <=
                e.getBoundingClientRect().bottom + 1,
            );
        }),
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await expect(page.getByRole("heading", { name: "Your timetable", exact: true })).toBeAttached();
    await page.getByTestId("filters-toggle").scrollIntoViewIfNeeded();
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

test("rebooking creates a separately priced visit and opens its saved day without changing history", async ({
  page,
}) => {
  await enter(page);
  const [original] = await populateCalendar(page);
  let w = await (await page.request.get(base + "/workspace")).json();
  const service = w.services.find((s: any) => s.id === original.service_id);
  const updated = await page.request.put(base + `/services/${service.id}`, {
    headers: { Origin: origin },
    data: {
      name: service.name,
      category: service.category,
      duration_min: service.duration_min,
      price_pence: 3700,
      active: 1,
      version: service.version,
    },
  });
  expect(updated.status()).toBe(200);
  await refreshView(page);
  await page
    .getByRole("button", { name: /^5 minute fictional client with/ })
    .click();
  await page.getByRole("button", { name: "Book again", exact: true }).click();
  await expect(page.getByLabel("Previous visit")).toContainText(
    "previous price £25",
  );
  await expect(page.getByLabel("Customer name", { exact: true })).toHaveValue(
    original.customer_name,
  );
  await expect(page.getByLabel("Mobile number", { exact: true })).toHaveValue(
    original.phone,
  );
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "4 weeks", exact: true }).click();
  const nextDate = new Date(original.date + "T12:00:00Z");
  nextDate.setUTCDate(nextDate.getUTCDate() + 28);
  const target = nextDate.toISOString().slice(0, 10);
  await expect(page.getByLabel("Booking date", { exact: true })).toHaveValue(
    target,
  );
  await page
    .getByRole("button", { name: "Use first available time", exact: true })
    .click();
  await expect(page.getByLabel("Available start time")).toHaveValue("540");
  await page
    .getByRole("button", { name: "Review appointment", exact: true })
    .click();
  await expect(page.getByLabel("Review appointment details")).toContainText(
    "£37",
  );
  await expect(page.getByLabel("Review appointment details")).toBeFocused();
  await page
    .getByRole("button", { name: "Edit selections", exact: true })
    .click();
  await expect(page.getByLabel("Customer name", { exact: true })).toHaveValue(
    original.customer_name,
  );
  await page
    .getByRole("button", { name: "Review appointment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm test booking", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByLabel("Appointment date", { exact: true }),
  ).toHaveValue(target);
  const created = (
    await (await page.request.get(base + "/bookings?date=" + target)).json()
  ).bookings;
  expect(created).toHaveLength(1);
  expect(created[0].id).not.toBe(original.id);
  expect(created[0].sequence).not.toBe(original.sequence);
  expect(created[0].price_pence).toBe(3700);
  expect(
    (await (await page.request.get(base + "/bookings/" + original.id)).json())
      .booking,
  ).toEqual(original);
  await page.reload();
  await page.getByLabel("Appointment date", { exact: true }).fill(target);
  await expect(
    page.getByRole("button", { name: /^5 minute fictional client with/ }),
  ).toBeVisible();
});

test("rebooking unavailable service requires a replacement and appointment action changes protect unsaved notes", async ({
  page,
}) => {
  await enter(page);
  const [original] = await populateCalendar(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  const service = w.services.find((s: any) => s.id === original.service_id);
  await page.request.put(base + `/services/${service.id}`, {
    headers: { Origin: origin },
    data: {
      name: service.name,
      category: service.category,
      duration_min: service.duration_min,
      price_pence: service.price_pence,
      active: 0,
      version: service.version,
    },
  });
  await refreshView(page);
  await page
    .getByRole("button", { name: /^5 minute fictional client with/ })
    .click();
  const panel = page.getByTestId("appointment-panel");
  await panel.getByRole("button", { name: "Add note" }).click();
  await panel.getByLabel("Appointment note").fill("Draft status note");
  await page.getByRole("button", { name: "Book again", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "unsaved appointment changes",
  );
  await page.getByRole("button", { name: "Keep editing appointment" }).click();
  await expect(panel.getByLabel("Appointment note")).toHaveValue(
    "Draft status note",
  );
  await page.getByRole("button", { name: "Book again", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes and continue", exact: true })
    .click();
  await expect(page.getByLabel("Service", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Previous visit")).toContainText("unavailable");
  await expect(page.getByLabel("Customer name", { exact: true })).toHaveValue(
    original.customer_name,
  );
  await page
    .getByLabel("Service", { exact: true })
    .selectOption(
      w.services.find((s: any) => s.id !== original.service_id && s.active).id,
    );
  await expect(
    page.getByRole("button", { name: "Use first available time", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "6 weeks", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alert")).toContainText("unsaved changes");
  await page.getByRole("button", { name: "Discard changes and close" }).click();
  expect(
    (await (await page.request.get(base + "/bookings/" + original.id)).json())
      .booking,
  ).toEqual(original);
});

test("pending status save blocks action switching and first-time shortcut never invents availability", async ({
  page,
}) => {
  await enter(page);
  const [original] = await populateCalendar(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/app/bookings/*/details", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: /^5 minute fictional client with/ })
    .click();
  const panel = page.getByTestId("appointment-panel");
  await panel.getByRole("button", { name: "Add note" }).click();
  await panel.getByLabel("Appointment note").fill("Slow save");
  await panel.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Book again", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("save is in progress");
  await expect(page.getByLabel("Previous visit")).toHaveCount(0);
  release();
  // The note lands and the panel stays open; "Book again" is now free to switch.
  await expect(panel.locator(".panel-notes p")).toContainText("Slow save");
  await page.getByRole("button", { name: "Book again", exact: true }).click();
  const sunday = new Date(original.date + "T12:00:00Z");
  sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7) + 7);
  await page
    .getByLabel("Booking date", { exact: true })
    .fill(sunday.toISOString().slice(0, 10));
  await expect(
    page.getByRole("button", { name: "Use first available time", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Available start time")).toHaveValue("");
  await expect(
    page.getByText("No available times.", { exact: false }),
  ).toBeVisible();
});

for (const width of [320, 390, 768, 844, 1024, 1440, 1920])
  test(`responsive rebook and move review at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    if (width === 844) await page.setViewportSize({ width, height: 390 });
    if (width === 1920) await page.setViewportSize({ width, height: 1080 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await enter(page);
    const [original] = await populateCalendar(page);
    await page
      .getByRole("button", { name: /^5 minute fictional client with/ })
      .click();
    await page.getByRole("button", { name: "Book again", exact: true }).click();
    await page
      .getByRole("button", { name: "Use first available time", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review appointment", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      page.getByRole("button", { name: "Close dialog", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole("button", { name: "Confirm test booking", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    if (width === 1440) {
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      expect(
        await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page.evaluate(() => {
        document.documentElement.style.zoom = "";
      });
    }
    expect(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`rebook-review-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Discard changes and close" })
      .click();
    await page
      .getByRole("button", { name: /^5 minute fictional client with/ })
      .click();
    await page.getByRole("button", { name: "Reschedule", exact: true }).click();
    await page.getByLabel("Available start time").selectOption("900");
    await page
      .getByLabel("Reason for rescheduling")
      .fill("Fictional customer requested move");
    await page
      .getByRole("button", { name: "Review appointment", exact: true })
      .click();
    await expect(page.locator(".reschedule-comparison")).toContainText("09:00");
    await expect(page.locator(".reschedule-comparison")).toContainText("15:00");
    expect(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`move-review-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Confirm reschedule", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const moved = (
      await (await page.request.get(base + "/bookings/" + original.id)).json()
    ).booking;
    expect(moved.start_min).toBe(900);
    expect(moved.items_json).toBe(original.items_json);
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

test("week view shows the seven-day load per barber, drills into a day, and opens a booking", async ({
  page,
}) => {
  await enter(page);
  const bookings = await populateCalendar(page);
  const date = bookings[0].date;
  await page.getByRole("button", { name: "Week", exact: true }).click();
  const week = page.locator(".week-view");
  await expect(week).toBeVisible();
  await expect(week).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText(/^Week of /)).toBeVisible();
  // Seven day heads, every card present, each barber row counts its own visits.
  await expect(week.locator(".week-day-head")).toHaveCount(7);
  await expect(week.locator(".week-card")).toHaveCount(4);
  await expect(week.locator(".week-row").first()).toContainText("2 this week");
  await expect(week.locator(".week-row").nth(1)).toContainText("2 this week");
  // The chosen day head announces its load and links to the timetable.
  const head = week.locator(".week-day-head.chosen");
  await expect(head).toHaveAttribute("aria-label", /4 appointments, \d+% booked/);
  // Opening a card opens the same appointment dialog as the day view.
  await week.locator(".week-card").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("5 minute fictional client");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Clicking a different day switches to that day's timetable.
  const nextHead = week.locator(".week-day-head:not(.chosen)").first();
  const label = (await nextHead.getAttribute("aria-label")) || "";
  await nextHead.click();
  await expect(page.getByRole("button", { name: "Day timetable", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(label).toContain("Open day timetable");
  expect(await page.getByLabel("Appointment date", { exact: true }).inputValue()).not.toBe(date);
  // Accessibility of the week view at desktop width.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(week).toHaveAttribute("aria-busy", "false");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations).toEqual([]);
});

test("standing booking: repeat controls preview every date, conflicts must be skipped, and one confirm saves the series", async ({
  page,
}) => {
  test.setTimeout(90000);
  await enter(page);
  const headers = { Origin: origin };
  const w = await (await page.request.get(base + "/workspace")).json();
  const start = day(8);
  const conflict = new Date(start + "T12:00:00Z");
  conflict.setUTCDate(conflict.getUTCDate() + 14);
  const blocked = conflict.toISOString().slice(0, 10);
  const leave = await page.request.post(base + `/staff/${w.staff[0].id}/days-off`, {
    headers,
    data: { date: blocked, reason: "Fictional leave" },
  });
  expect(leave.status()).toBe(201);
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Barber").selectOption(w.staff[0].id);
  await dialog.getByLabel("Booking date").fill(start);
  const timeSelect = dialog.getByLabel("Available start time");
  await expect(timeSelect.locator("option[value='600']")).toBeEnabled();
  await timeSelect.selectOption("600");
  await dialog.getByLabel("Customer name", { exact: true }).fill("Standing Regular");
  await dialog.getByLabel("Mobile number", { exact: true }).fill("07700900555");
  // Repeat controls are only offered for a new booking.
  const repeat = dialog.getByLabel("Repeat this appointment at the same time");
  await repeat.check();
  await dialog.getByLabel("Every").selectOption("2");
  await dialog.getByLabel("Visits").fill("3");
  await dialog.getByRole("button", { name: "Review appointment" }).click();
  const preview = dialog.getByTestId("series-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator("li")).toHaveCount(3);
  await expect(preview).toContainText("2 of 3 dates bookable");
  await expect(preview.locator("li.is-blocked")).toHaveCount(1);
  await expect(preview.locator("li.is-blocked")).toContainText(blocked);
  // Confirming with an unresolved conflict is refused client-side; nothing is written.
  await dialog.getByRole("button", { name: /^Confirm standing booking \(2 dates\)/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("Skip the 1 unavailable date");
  expect((await (await page.request.get(base + "/workspace")).json()).bookings).toHaveLength(0);
  await dialog.getByLabel(`Skip ${blocked}`).check();
  await expect(preview.locator("li.is-skipped")).toHaveCount(1);
  await dialog.getByRole("button", { name: /^Confirm standing booking \(2 dates\)/ }).click();
  // Saved: two appointments share a series id and the calendar shows the first one.
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const last = new Date(start + "T12:00:00Z");
  last.setUTCDate(last.getUTCDate() + 28);
  const range = await (
    await page.request.get(base + `/bookings/range?from=${start}&to=${last.toISOString().slice(0, 10)}`)
  ).json();
  const series = range.bookings.filter((b: any) => b.series_id);
  expect(series).toHaveLength(2);
  expect(new Set(series.map((b: any) => b.series_id)).size).toBe(1);
  expect(series.map((b: any) => b.date)).not.toContain(blocked);
  await expect(page.locator(".calendar-event")).toHaveCount(1);
  // Rescheduling an existing visit never shows repeat controls.
  await page.locator(".calendar-event").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByTestId("series-options")).toHaveCount(0);
});

test("walk-in: seats someone now with no phone, lands on today's timetable as WALK_IN, no customer record is created", async ({ page }) => {
  await openFixtureShop(page);
  const w = await (await page.request.get(base + "/workspace")).json();
  const nowMin = (() => {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
  })();
  const dayHours = JSON.parse(w.shop.week_json)[new Date(w.today + "T12:00:00Z").getUTCDay()];
  test.skip(!dayHours.enabled || nowMin < dayHours.starts || nowMin > dayHours.ends - 60, "walk-ins only make sense during opening hours");
  const before = (await (await page.request.get(base + "/customers")).json()).customers.length;
  await page.getByTestId("walk-in").click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("heading", { name: "Walk-in" })).toBeVisible();
  const barber = w.staff.find((s: any) => s.active);
  await dlg.getByTestId("walkin-barber").selectOption(barber.id);
  await dlg.getByTestId("walkin-service").selectOption({ index: 1 });
  const seat = dlg.getByRole("button", { name: /^Seat now · \d{2}:\d{2}$/ });
  const skipped = (await dlg.getByText("No free time left today").count()) > 0;
  test.skip(skipped, "fixture barber is fully booked right now");
  await expect(seat).toBeVisible();
  const label = await seat.innerText();
  const startMin = (() => { const [h, m] = label.split("· ")[1].split(":").map(Number); return h * 60 + m; })();
  // The offered start is the current slot or later, never more than 15 minutes ago.
  expect(startMin).toBeGreaterThanOrEqual(Math.floor(nowMin / 15) * 15 - 15);
  await seat.click();
  await expect(dlg).toBeHidden();
  const after = await (await page.request.get(base + `/bookings?date=${w.today}&limit=200`)).json();
  const seated = after.bookings.find((b: any) => b.source === "WALK_IN" && b.customer_name === "Walk-in" && b.start_min === startMin);
  expect(seated).toBeTruthy();
  expect(seated.phone).toBe("");
  expect(seated.customer_id).toBeNull();
  expect((await (await page.request.get(base + "/customers")).json()).customers.length).toBe(before);
  // Non-walk-in bookings still require a phone.
  const bad = await page.request.post(base + "/bookings", {
    headers: { Origin: origin },
    data: { request_id: crypto.randomUUID(), staff_id: barber.id, service_id: w.services[0].id, customer_name: "No Phone", phone: "", date: w.today, start_min: startMin, source: "TEST_BOOKING", addon_ids: [], quote: { service_version: 0, shop_version: 0 } },
  });
  expect(bad.status()).toBe(400);
});
