import {
  test,
  expect,
  request,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { section } from "./fixture";
import type { WorkspaceData, BookingItem } from "../src/server/domain";
import { base, origin, newShop, enterNewShop, shopPayload } from "./shop";
import { refreshView } from "./fixture";
const day = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 8);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
async function owner() {
  return (await newShop("Catalogue test shop")).r;
}
async function ws(r: APIRequestContext): Promise<WorkspaceData> {
  const q = await r.get(base + "/workspace");
  expect(q.status()).toBe(200);
  return q.json();
}
async function quote(
  r: APIRequestContext,
  w: WorkspaceData,
  addons: string[] = [],
  staffId = w.staff[0].id,
  date = day(),
  bookingId?: string,
) {
  const service = w.services.find((s) => s.name === "Signature cut")!;
  return r.get(
    base +
      "/availability?" +
      new URLSearchParams({
        date,
        staff_id: staffId,
        service_id: service.id,
        addon_ids: addons.join(","),
        ...(bookingId ? { booking_id: bookingId } : {}),
      }),
  );
}
async function booking(
  r: APIRequestContext,
  w: WorkspaceData,
  addons: string[] = [],
  start = 540,
  requestId = crypto.randomUUID(),
) {
  const q = await (await quote(r, w, addons)).json();
  return r.post(base + "/bookings", {
    data: {
      request_id: requestId,
      staff_id: w.staff[0].id,
      service_id: w.services.find((s) => s.name === "Signature cut")!.id,
      customer_name: "Fictional Addon Client",
      phone: "07700900123",
      date: day(),
      start_min: start,
      source: "TEST_BOOKING",
      addon_ids: addons,
      quote: q.quote,
    },
  });
}
async function addon(r: APIRequestContext, w: WorkspaceData, duration = 20) {
  const res = await r.post(base + "/addons", {
    data: {
      name: "Hot towel test",
      price_pence: 650,
      duration_min: duration,
      active: 1,
      service_ids: [w.services.find((s) => s.name === "Signature cut")!.id],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}
const serviceBody = (s: WorkspaceData["services"][0]) => ({
  name: s.name,
  category: s.category,
  duration_min: s.duration_min,
  price_pence: s.price_pence,
  active: s.active,
  version: s.version,
});

test("add-ons and barber overrides persist, protect tenants and keep immutable booked items", async () => {
  const a = await owner(),
    b = await owner();
  const w = await ws(a),
    other = await ws(b);
  const s = w.services.find((s) => s.name === "Signature cut")!,
    staff = w.staff[0];
  const id = await addon(a, w);
  const rule = { enabled: 1, price_pence: 3300, duration_min: 25, version: 0 };
  expect(
    (
      await a.put(base + `/staff/${staff.id}/services/${s.id}`, { data: rule })
    ).status(),
  ).toBe(200);
  let q = await (await quote(a, w, [id])).json();
  expect(q.price_pence).toBe(3950);
  expect(q.duration_min).toBe(45);
  expect(q.items.map((i: BookingItem) => i.kind)).toEqual(["SERVICE", "ADDON"]);
  expect(q.overridden).toBe(true);
  const after = await ws(a);
  expect(after.addons).toHaveLength(1);
  expect(after.service_rules[0].version).toBe(1);
  const foreignAddon = {
    name: "Forged addon",
    price_pence: 100,
    duration_min: 10,
    active: 1,
    service_ids: [s.id],
  };
  expect(
    (await b.post(base + "/addons", { data: foreignAddon })).status(),
  ).toBe(404);
  expect(
    (
      await b.put(base + "/addons/" + id, {
        data: {
          ...foreignAddon,
          service_ids: [other.services[0].id],
          version: 0,
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await b.put(base + `/staff/${staff.id}/services/${s.id}`, { data: rule })
    ).status(),
  ).toBe(404);
  expect(
    (
      await a.put(
        base + `/staff/${staff.id}/services/${other.services[0].id}`,
        { data: rule },
      )
    ).status(),
  ).toBe(404);
  expect((await quote(b, other, [id])).status()).toBe(409);
  expect((await quote(a, w, [id, id])).status()).toBe(400);
  const made = await booking(a, w, [id]);
  expect(made.status(), await made.text()).toBe(201);
  const saved = (await made.json()).booking;
  const items = saved.items_json;
  expect(JSON.parse(items)[0].duration_min).toBe(25);
  expect(JSON.parse(items)[1].price_pence).toBe(650);
  expect(
    (
      await a.put(base + "/addons/" + id, {
        data: {
          name: "Edited towel",
          price_pence: 999,
          duration_min: 5,
          active: 0,
          service_ids: [s.id],
          version: 0,
        },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await a.put(base + "/addons/" + id, {
        data: {
          name: "Stale",
          price_pence: 1,
          duration_min: 5,
          active: 1,
          service_ids: [s.id],
          version: 0,
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await a.put(base + `/staff/${staff.id}/services/${s.id}`, {
        data: { enabled: 1, price_pence: null, duration_min: null, version: 1 },
      })
    ).status(),
  ).toBe(200);
  const current = (await (await a.get(base + "/bookings/" + saved.id)).json())
    .booking;
  expect(current.items_json).toBe(items);
  expect(current.price_pence).toBe(3950);
  q = await (await quote(a, w, [], staff.id, day(), saved.id)).json();
  expect(q.items).toEqual(JSON.parse(items));
  expect(q.duration_min).toBe(45);
  const move = await a.post(base + `/bookings/${saved.id}/reschedule`, {
    data: {
      staff_id: staff.id,
      date: day(),
      start_min: 900,
      version: 0,
      reason: "Retain historical quote",
    },
  });
  expect(move.status()).toBe(200);
  expect((await move.json()).booking.items_json).toBe(items);
  const final = await ws(a);
  expect(final.audit.filter((a) => a.action === "ADDON_UPDATED")).toHaveLength(
    1,
  );
  expect((await ws(b)).addons).toHaveLength(0);
  await Promise.all([a.dispose(), b.dispose()]);
});

test("aggregate duration locks overlaps, rejects stale quote and eligibility changes, and allows exact buffer boundary", async () => {
  const r = await owner();
  const w = await ws(r);
  const s = w.services.find((s) => s.name === "Signature cut")!,
    staff = w.staff[0];
  const id = await addon(r, w, 20);
  const initial = await (await quote(r, w, [id])).json();
  expect(initial.duration_min).toBe(50);
  const starts = await Promise.all(
    Array.from({ length: 6 }, () => booking(r, w, [id], 540)),
  );
  expect(starts.filter((r) => r.status() === 201)).toHaveLength(1);
  expect(starts.filter((r) => r.status() === 409)).toHaveLength(5);
  expect((await booking(r, w, [], 585)).status()).toBe(409);
  expect((await booking(r, w, [], 600)).status()).toBe(201);
  const stale = await (await quote(r, w, [id])).json();
  await r.put(base + "/addons/" + id, {
    data: {
      name: "Updated towel",
      price_pence: 700,
      duration_min: 20,
      active: 1,
      service_ids: [s.id],
      version: 0,
    },
  });
  const payload = {
    request_id: crypto.randomUUID(),
    staff_id: staff.id,
    service_id: s.id,
    customer_name: "Stale quote client",
    phone: "07700900123",
    date: day(),
    start_min: 900,
    source: "TEST_BOOKING",
    addon_ids: [id],
    quote: stale.quote,
  };
  const rejected = await r.post(base + "/bookings", { data: payload });
  expect(rejected.status()).toBe(409);
  expect((await rejected.json()).error).toBe("quote_changed");
  await r.put(base + `/staff/${staff.id}/services/${s.id}`, {
    data: { enabled: 0, price_pence: null, duration_min: null, version: 0 },
  });
  expect((await quote(r, w, [])).status()).toBe(409);
  const after = await ws(r);
  expect(after.issues.some((i) => i.reason.includes("no longer offers"))).toBe(
    true,
  );
  const existing = after.bookings[0];
  expect(
    (
      await r.post(base + `/bookings/${existing.id}/reschedule`, {
        data: {
          staff_id: staff.id,
          date: day(),
          start_min: 900,
          version: existing.version,
          reason: "Ineligible move",
        },
      })
    ).status(),
  ).toBe(409);
  expect((await ws(r)).bookings).toHaveLength(2);
  await r.dispose();
});

test("dated partial shifts replace weekly hours, keep closure precedence, flag bookings and reject stale/cross-shop writes", async () => {
  const r = await owner(),
    other = await owner();
  const w = await ws(r);
  const staff = w.staff[0];
  expect((await booking(r, w)).status()).toBe(201);
  const hours = {
    date: day(),
    enabled: 1,
    starts: 600,
    ends: 960,
    break_start: 720,
    break_end: 750,
    reason: "Partial-day test",
  };
  expect(
    (
      await other.post(base + `/staff/${staff.id}/overrides`, { data: hours })
    ).status(),
  ).toBe(404);
  expect(
    (
      await r.post(base + `/staff/${staff.id}/overrides`, {
        data: { ...hours, break_end: 970 },
      })
    ).status(),
  ).toBe(400);
  const created = await r.post(base + `/staff/${staff.id}/overrides`, {
    data: hours,
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id;
  expect(
    (
      await r.post(base + `/staff/${staff.id}/overrides`, { data: hours })
    ).status(),
  ).toBe(409);
  let q = await (await quote(r, w)).json();
  const reason = (n: number) =>
    q.slots.find((s: { start_min: number }) => s.start_min === n).reason;
  expect(reason(540)).toBe("Outside working hours");
  expect(reason(690)).toBe("Lunch break");
  expect(reason(765)).toBe("");
  expect(reason(930)).toBe("Outside working hours");
  expect((await ws(r)).issues[0].reason).toBe("Outside working hours");
  // Weekly lunch is replaced: 13:00 is now bookable, unlike the seeded weekly break.
  expect(reason(780)).toBe("");
  expect((await booking(r, w, [], 780)).status()).toBe(201);
  expect(
    (
      await r.put(base + `/staff/${staff.id}/overrides/${id}`, {
        data: { ...hours, ends: 1020, version: 0 },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await r.put(base + `/staff/${staff.id}/overrides/${id}`, {
        data: { ...hours, version: 0 },
      })
    ).status(),
  ).toBe(409);
  expect(
    (await other.delete(base + `/staff/${staff.id}/overrides/${id}`)).status(),
  ).toBe(404);
  const leave = await r.post(base + `/staff/${staff.id}/days-off`, {
    data: { date: day(), reason: "Leave takes priority" },
  });
  q = await (await quote(r, w)).json();
  expect(
    q.slots.every(
      (s: { reason: string }) => s.reason === "Barber has a day off",
    ),
  ).toBe(true);
  await r.delete(
    base + `/staff/${staff.id}/days-off/${(await leave.json()).id}`,
  );
  const closed = await r.post(base + "/holidays", {
    data: { date: day(), label: "Closure precedence" },
  });
  q = await (await quote(r, w)).json();
  expect(
    q.slots.every((s: { reason: string }) => s.reason === "Shop closed"),
  ).toBe(true);
  await r.delete(base + "/holidays/" + (await closed.json()).id);
  expect(
    (await r.delete(base + `/staff/${staff.id}/overrides/${id}`)).status(),
  ).toBe(200);
  const final = await ws(r);
  expect(final.schedule_overrides).toHaveLength(0);
  expect(final.bookings).toHaveLength(2);
  expect(
    final.audit.filter((a) => a.action === "DATED_HOURS_UPDATED"),
  ).toHaveLength(1);
  await Promise.all([r.dispose(), other.dispose()]);
});

async function enter(page: Page) {
  await enterNewShop(page, "Catalogue UI shop");
}
async function save(page: Page, name = "Save changes") {
  await page
    .getByRole("dialog")
    .getByRole("button", { name, exact: true })
    .click();
  if (name.endsWith(" rule")) {
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "This service rule is saved" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  }
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

test("owner edits add-ons, barber pricing and partial shifts; booking items survive reload and later catalogue edits", async ({
  page,
}) => {
  await enter(page);
  await section(page, "Services");
  await page.getByRole("button", { name: "Add add-on", exact: true }).click();
  await page.getByLabel("Add-on name").fill("Towel ritual");
  await page.getByLabel("Add-on price (£)").fill("6.50");
  await page.getByLabel("Extra minutes").fill("20");
  await save(page);
  await section(page, "Team");
  const editor = page.getByTestId("barber-editor");
  await page.getByTestId("team-card").filter({ hasText: "Jay Carter" }).click();
  await editor
    .getByRole("button", { name: "Services & pricing", exact: true })
    .click();
  await page.getByLabel("Jay Carter price for Signature cut").fill("33");
  await page.getByLabel("Jay Carter duration for Signature cut").fill("25");
  await page
    .getByRole("button", { name: "Save barber rules", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText("saved");
  await editor.getByRole("button", { name: "Schedule", exact: true }).click();
  await page.getByRole("button", { name: /^Dated hours/ }).click();
  await page
    .getByRole("button", { name: "Add dated hours", exact: true })
    .click();
  await page.getByLabel("Date", { exact: true }).fill(day());
  await page.getByLabel("Starts", { exact: true }).fill("10:00");
  await page.getByLabel("Finishes", { exact: true }).fill("17:00");
  await page.getByLabel("Break from", { exact: true }).fill("12:00");
  await page.getByLabel("Break until", { exact: true }).fill("12:30");
  await page.getByLabel("Why (shows in the audit)").fill("Late start test");
  await save(page);
  await page.reload();
  await section(page, "Appointments");
  await page.getByLabel("Appointment date", { exact: true }).fill(day());
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await page
    .getByLabel("Service", { exact: true })
    .selectOption({ label: "Signature cut" });
  await page.getByLabel("Towel ritual", { exact: false }).check();
  await expect(page.locator(".workspace-quote")).toContainText("£39.50");
  await expect(page.locator(".workspace-quote")).toContainText("45");
  await expect(
    page.getByText("Barber-specific price / duration", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", {
      name: "09:00 — Outside working hours",
      exact: true,
    }),
  ).toHaveJSProperty("disabled", true);
  await page.getByLabel("Available start time").selectOption("600");
  await page
    .getByLabel("Customer name", { exact: true })
    .fill("Combined quote client");
  await page.getByLabel("Mobile number", { exact: true }).fill("07700900123");
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await section(page, "Services");
  await page
    .getByRole("button", { name: /Towel ritual/ })
    .click();
  await page.getByLabel("Add-on price (£)").fill("9");
  await save(page);
  await page.reload();
  await page.getByLabel("Appointment date", { exact: true }).fill(day());
  await page
    .getByRole("button")
    .filter({ hasText: "Combined quote client" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("£39.50");
  await expect(
    page.locator(".workspace-booking-detail .workspace-quote-items"),
  ).toContainText("£6.50");
});

test("changing add-ons invalidates a selected slot, preserves contact fields and recovers from a refreshed-price conflict", async ({
  page,
}) => {
  await enter(page);
  const w = await ws(page.request),
    s = w.services.find((s) => s.name === "Signature cut")!;
  const added = await page.request.post(base + "/addons", {
    headers: { Origin: origin },
    data: {
      name: "Long finish",
      price_pence: 500,
      duration_min: 40,
      active: 1,
      service_ids: [s.id],
    },
  });
  expect(added.status()).toBe(201);
  const id = (await added.json()).id;
  const q = await (await quote(page.request, w)).json();
  const existing = await page.request.post(base + "/bookings", {
    headers: { Origin: origin },
    data: {
      request_id: crypto.randomUUID(),
      staff_id: w.staff[0].id,
      service_id: s.id,
      customer_name: "Existing slot",
      phone: "07700900123",
      date: day(),
      start_min: 600,
      source: "TEST_BOOKING",
      quote: q.quote,
    },
  });
  expect(existing.status()).toBe(201);
  await refreshView(page);
  await expect(
    page.getByRole("button", { name: "New booking", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Appointment date", { exact: true }).fill(day());
  await page.getByRole("button", { name: "New booking", exact: true }).click();
  await page
    .getByLabel("Service", { exact: true })
    .selectOption({ label: "Signature cut" });
  await page.getByLabel("Available start time").selectOption("540");
  await page
    .getByLabel("Customer name", { exact: true })
    .fill("Preserved addon draft");
  await page.getByLabel("Mobile number", { exact: true }).fill("07700900123");
  await page.getByLabel("Long finish", { exact: false }).check();
  await expect(page.getByLabel("Available start time")).toHaveValue("");
  await expect(
    page.getByRole("option", { name: "09:00 — Slot taken", exact: true }),
  ).toHaveJSProperty("disabled", true);
  await expect(page.getByLabel("Customer name", { exact: true })).toHaveValue(
    "Preserved addon draft",
  );
  await page.getByLabel("Available start time").selectOption("900");
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.request.put(base + "/addons/" + id, {
    headers: { Origin: origin },
    data: {
      name: "Long finish",
      price_pence: 700,
      duration_min: 40,
      active: 1,
      service_ids: [s.id],
      version: 0,
    },
  });
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("alert")).toContainText("changed");
  await expect(page.getByLabel("Customer name", { exact: true })).toHaveValue(
    "Preserved addon draft",
  );
  await expect(page.locator(".workspace-quote")).toContainText("£35");
  await page.getByLabel("Available start time").selectOption("900");
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.getByRole("button", { name: "Confirm test booking" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect((await ws(page.request)).bookings).toHaveLength(2);
});

for (const width of [390, 1440])
  test(`new catalogue and override forms are accessible at ${width}px`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
        viewport: { width, height: 900 },
      }),
      page = await context.newPage();
    await enter(page);
    await section(page, "Services");
    await page.getByRole("button", { name: "Add add-on", exact: true }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("addon-form.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await section(page, "Team");
    const editor = page.getByTestId("barber-editor");
    await page
      .getByTestId("team-card")
      .filter({ hasText: "Jay Carter" })
      .click();
    await editor
      .getByRole("button", { name: "Services & pricing", exact: true })
      .click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("barber-rules.png"),
      fullPage: true,
    });
    await editor.getByRole("button", { name: "Schedule", exact: true }).click();
    await page.getByRole("button", { name: /^Dated hours/ }).click();
    await page
      .getByRole("button", { name: "Add dated hours", exact: true })
      .click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("dated-hours.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await context.close();
  });

test("services empty state and category rename", async ({ page }) => {
  // Fresh shop straight from signup: no services yet.
  const res = await page.request.post(base + "/auth/signup", {
    headers: { Origin: origin },
    data: { shop_name: "Empty Cuts", name: "Em Owner", email: `em-${crypto.randomUUID().slice(0, 8)}@ollo.test`, password: "Unique fictional test password 438!" },
  });
  expect(res.status(), await res.text()).toBe(201);
  await page.goto("/workspace");
  await section(page, "Services");
  await expect(page.getByTestId("services-empty")).toBeVisible();
  await page.getByTestId("add-first-service").click();
  await page.getByLabel("Service name").fill("Skin fade");
  await page.getByLabel("Category", { exact: true }).fill("Hair");
  await page.getByLabel("Price (£)", { exact: true }).fill("30");
  await page.getByRole("button", { name: "Create service", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Skin fade" })).toBeVisible();
  await expect(page.getByTestId("services-empty")).toHaveCount(0);
  // Rename the category from the list header.
  await page.getByRole("button", { name: "Rename category Hair" }).click();
  await page.getByLabel("Rename category Hair").fill("Cuts & fades");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cuts & fades" })).toBeVisible();
  const w = await (await page.request.get(base + "/workspace")).json();
  expect(w.services.every((s: any) => s.category === "Cuts & fades")).toBe(true);
  expect(w.audit.some((a: any) => a.action === "CATEGORY_RENAMED")).toBe(true);
  // Too-short name is refused inline.
  await page.getByRole("button", { name: "Rename category Cuts & fades" }).click();
  await page.getByLabel("Rename category Cuts & fades").fill("X");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("2 characters");
});

test("shop currency and logo flow through settings, workspace, and the public page", async ({ page }) => {
  const res = await page.request.post(base + "/auth/signup", {
    headers: { Origin: origin },
    data: { shop_name: "Euro Cuts", name: "Eu Owner", email: `eu-${crypto.randomUUID().slice(0, 8)}@ollo.test`, password: "Unique fictional test password 438!" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const w0 = await (await page.request.get(base + "/workspace")).json();
  // Currency via the settings API, logo via the shop page API (uploads reuse the media pipeline; a URL is enough here).
  const put = await page.request.put(base + "/shop", { headers: { Origin: origin }, data: shopPayload(w0.shop, { currency: "EUR" }) });
  expect(put.status(), await put.text()).toBe(200);
  const pg = await page.request.put(base + "/shop/page", { headers: { Origin: origin }, data: { logo_url: "https://example.com/logo.png", version: 0 } });
  expect(pg.status(), await pg.text()).toBe(200);
  const w = await (await page.request.get(base + "/workspace")).json();
  expect(w.shop.currency).toBe("EUR");
  expect(w.logo_url).toBe("https://example.com/logo.png");
  await page.goto("/workspace");
  await section(page, "Settings");
  await expect(page.getByTestId("shop-currency")).toHaveValue("EUR");
  await expect(page.getByLabel(/Deposit \(€\)/)).toBeVisible();
  await expect(page.locator("img.avatar-logo").first()).toHaveAttribute("src", "https://example.com/logo.png");
  await section(page, "Services");
  await page.getByTestId("add-first-service").click();
  await expect(page.getByLabel("Price (€)", { exact: true })).toBeVisible();
});
