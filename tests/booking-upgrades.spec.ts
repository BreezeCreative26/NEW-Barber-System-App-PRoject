// Booking flow upgrades: any-barber shortcut from the service step, book for someone else
// (attendee on the visit, contact stays the booker's), and group bookings (2-4 people, together or
// back to back; each visit its own row under every guard, shared group_id, partial failure honest).
import { test, expect, request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { base, origin, openFixtureShop } from "./fixture";

async function fixture() {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await r.post(base + "/auth/demo", { data: { fixture: true } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { slug: string };
  const w = await (await r.get(base + "/workspace")).json();
  const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  return { r, c, w, slug: body.slug, P: `${origin}/api/public/shops/${body.slug}` };
}
const dateIn = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
// A weekday a few days out so every barber has hours.
function weekdayAhead(from = 3) {
  for (let d = from; d < from + 7; d++) {
    const wd = new Date(dateIn(d) + "T12:00:00Z").getUTCDay();
    if (wd >= 2 && wd <= 5) return dateIn(d);
  }
  return dateIn(from);
}

test("group availability: together assigns distinct barbers, back to back chains one barber with the buffer; saving shares a group_id and replays", async () => {
  const { r, c, w, P } = await fixture();
  const [s0, s1] = w.services;
  const date = weekdayAhead();
  const bad = await c.get(`${P}/group-availability?date=${date}&members=${encodeURIComponent(`${s0.id}:any:`)}`);
  expect(bad.status()).toBe(400); // one member is not a group
  const res = await c.get(`${P}/group-availability?date=${date}&members=${encodeURIComponent(`${s0.id}:any:;${s1.id}:any:`)}`);
  expect(res.status(), await res.text()).toBe(200);
  const av = await res.json();
  const together = av.together.filter((o: { available: boolean }) => o.available);
  const b2b = av.back_to_back.filter((o: { available: boolean }) => o.available);
  expect(together.length).toBeGreaterThan(0);
  expect(b2b.length).toBeGreaterThan(0);
  expect(av.back_to_back_possible).toBe(true);
  for (const o of together) {
    expect(o.assignment).toHaveLength(2);
    expect(o.assignment[0].staff_id).not.toBe(o.assignment[1].staff_id);
    expect(o.assignment[0].start_min).toBe(o.start_min);
    expect(o.assignment[1].start_min).toBe(o.start_min);
  }
  for (const o of b2b) {
    expect(o.assignment[0].staff_id).toBe(o.assignment[1].staff_id);
    // Second starts on the quarter hour after first duration + 10-minute buffer.
    const expected = Math.ceil((o.assignment[0].start_min + o.assignment[0].duration_min + 10) / 15) * 15;
    expect(o.assignment[1].start_min).toBe(expected);
  }
  // Save a "together" group with an attendee on the second member.
  const pick = together[0];
  const request_id = crypto.randomUUID();
  const body = {
    request_id,
    customer_name: "Group Booker",
    phone: "07700900888",
    email: "",
    notes: "Two of us",
    date,
    members: pick.assignment.map((a: { staff_id: string; start_min: number }, i: number) => ({
      attendee_name: i ? "Little Sam" : "",
      staff_id: a.staff_id,
      service_id: i ? s1.id : s0.id,
      addon_ids: [],
      start_min: a.start_min,
      quote: av.quotes[i],
    })),
  };
  const saved = await c.post(`${P}/group-bookings`, { data: body });
  expect(saved.status(), await saved.text()).toBe(201);
  const g = await saved.json();
  expect(g.bookings).toHaveLength(2);
  expect(g.failed).toEqual([]);
  expect(g.manage_token).toMatch(/^[a-f0-9-]{72}$/);
  expect(g.bookings[1].attendee_name).toBe("Little Sam");
  expect(g.bookings[0].attendee_name).toBe("");
  expect(new Set(g.bookings.map((b: { group_id: string }) => b.group_id)).size).toBe(1);
  // Replay returns the same group; a fresh request for the same chairs fails wholesale (409), nothing half-saved.
  const again = await c.post(`${P}/group-bookings`, { data: body });
  expect(again.status()).toBe(201);
  expect((await again.json()).group_id).toBe(g.group_id);
  const clash = await c.post(`${P}/group-bookings`, { data: { ...body, request_id: crypto.randomUUID() } });
  expect(clash.status()).toBe(409);
  // Owner sees both rows under the group with the attendee, booked by the same customer record.
  const day = await (await r.get(base + `/bookings?date=${date}`)).json();
  const rows = day.bookings.filter((b: { group_id: string }) => b.group_id === g.group_id);
  expect(rows).toHaveLength(2);
  expect(rows.map((b: { attendee_name: string }) => b.attendee_name).sort()).toEqual(["", "Little Sam"]);
  expect(new Set(rows.map((b: { customer_id: string }) => b.customer_id)).size).toBe(1);
  // Partial failure: take one chair from a valid together option, then book that option → 207 with one failed.
  const pick2 = together.find((o: { start_min: number }) => o.start_min !== pick.start_min && Math.abs(o.start_min - pick.start_min) > 120);
  expect(pick2).toBeTruthy();
  const single = await c.post(`${P}/bookings`, {
    data: { request_id: crypto.randomUUID(), staff_id: pick2.assignment[0].staff_id, service_id: s0.id, customer_name: "Solo Walker", phone: "07700900999", email: "", notes: "", date, start_min: pick2.assignment[0].start_min, addon_ids: [], quote: av.quotes[0] },
  });
  expect(single.status(), await single.text()).toBe(201);
  const partial = await c.post(`${P}/group-bookings`, {
    data: { ...body, request_id: crypto.randomUUID(), members: body.members.map((m: { staff_id: string }, i: number) => ({ ...m, staff_id: pick2.assignment[i].staff_id, start_min: pick2.assignment[i].start_min })) },
  });
  expect(partial.status()).toBe(207);
  const pj = await partial.json();
  expect(pj.bookings).toHaveLength(1);
  expect(pj.failed).toHaveLength(1);
  expect(pj.failed[0].error).toBe("slot_taken");
  expect(pj.failed[0].attendee_name).toBe("Group Booker");
});

test("book for someone else: attendee saved and shown to owner, customer and manage link; contact stays the booker's", async ({ page }) => {
  const { r, w, slug, P } = await fixture();
  await page.goto(`/book/${slug}`);
  await page.getByRole("button", { name: new RegExp(w.services[0].name) }).click();
  // Any-barber shortcut jumps straight to the time step with every chair.
  await page.getByTestId("any-barber-skip").click();
  await expect(page.getByRole("heading", { name: "A time that works for you." })).toBeVisible();
  await expect(page.getByRole("button", { name: "First available" })).toHaveCount(0); // not on barber step
  const label = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" }).format(new Date(`${weekdayAhead()}T12:00:00Z`));
  for (let i = 0; i < 3; i++) {
    if (await page.getByRole("button", { name: new RegExp(`^${label},`) }).count()) break;
    await page.getByRole("button", { name: "Next week" }).click();
  }
  await page.getByRole("button", { name: new RegExp(`^${label},`) }).click();
  const slots = page.getByRole("group", { name: "Choose an appointment time" }).locator("button:not([disabled])");
  await expect(slots.first()).toBeVisible();
  // Any-barber slots carry the assigned barber's first name.
  await expect(slots.first().locator("small")).toHaveText(/\w+/);
  await slots.first().click();
  await page.getByRole("button", { name: "Your details", exact: true }).click();
  await page.getByLabel("Your name").fill("Parent Booker");
  await page.getByLabel("Mobile number").fill("07700 900444");
  await page.getByTestId("for-someone-else").check();
  await page.getByRole("button", { name: "Review booking" }).click();
  await expect(page.getByText("Who is the visit for?")).toBeVisible(); // required once ticked
  await page.getByTestId("attendee-name").fill("Sam (age 8)");
  await page.getByRole("button", { name: "Review booking" }).click();
  await expect(page.getByTestId("review-attendee")).toContainText("Sam (age 8)");
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.locator(".public-reference")).toHaveText(/^BRB-\d{4}$/);
  await expect(page.getByText(/Visit for/)).toContainText("Sam (age 8)");
  await expect(page.getByText(/booked by Parent Booker/)).toBeVisible();
  // Manage link shows it too.
  const href = (await page.locator(".public-manage-link").getAttribute("href"))!;
  const managed = await (await page.request.get(`/api/public${href}`)).json();
  expect(managed.booking.attendee_name).toBe("Sam (age 8)");
  expect(managed.booking.customer_name).toBe("Parent Booker");
  expect(managed.booking.phone).toBe("07700900444");
  // Owner: the customer record is the parent; the visit row carries the attendee.
  const dir = await (await r.get(base + "/customers?q=07700900444")).json();
  expect(dir.customers).toHaveLength(1);
  expect(dir.customers[0].name).toBe("Parent Booker");
  const day = await (await r.get(base + `/bookings?date=${managed.booking.date}`)).json();
  const row = day.bookings.find((b: { phone: string }) => b.phone === "07700900444");
  expect(row.attendee_name).toBe("Sam (age 8)");
  expect(row.customer_id).toBe(dir.customers[0].id);
  // The public API rejects a one-character attendee and accepts empty (booking for self).
  const bad = await page.request.post(`${P}/bookings`, {
    headers: { Origin: origin },
    data: { request_id: crypto.randomUUID(), staff_id: row.staff_id, service_id: row.service_id, customer_name: "X Y", attendee_name: "Q", phone: "07700900445", email: "", notes: "", date: row.date, start_min: row.start_min, addon_ids: [], quote: { service_version: 0, shop_version: 0 } },
  });
  expect(bad.status()).toBe(400);
});

test("browser: group booking together then confirm; owner calendar marks the group; customer area lists both with attendee", async ({ page }) => {
  const { slug } = await fixture();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`/${slug}`);
  const flow = page.locator(".booking-app.embedded");
  await flow.getByTestId("start-group").click();
  await expect(flow.getByRole("heading", { name: "Who’s coming?" })).toBeVisible();
  await expect(flow.getByTestId("group-next")).toBeDisabled(); // second person needs a name
  await flow.getByTestId("member-name").nth(0).fill("Dad");
  await flow.getByTestId("member-name").nth(1).fill("Little Sam");
  await flow.getByTestId("member-service").nth(1).selectOption({ index: 3 });
  await flow.getByTestId("add-member").click();
  await expect(flow.getByTestId("group-member")).toHaveCount(3);
  await flow.getByRole("button", { name: "Remove person 3" }).click();
  await expect(flow.getByTestId("group-member")).toHaveCount(2);
  await flow.getByTestId("group-next").click();
  await expect(flow.getByRole("heading", { name: "Pick a day and time." })).toBeVisible();
  // Move to a weekday with everyone in.
  const target = weekdayAhead();
  const dayBtn = flow.getByRole("group", { name: "Choose a day" }).getByRole("button", { name: new RegExp(`^\\w{3}\\s*${Number(target.slice(8))}$`) });
  if (!(await dayBtn.count())) await flow.getByRole("button", { name: "Next week" }).click();
  await dayBtn.first().click();
  await expect(flow.getByTestId("group-slot").first()).toBeVisible();
  await flow.getByTestId("group-slot").first().click();
  const plan = flow.getByTestId("group-plan");
  await expect(plan).toContainText("Dad");
  await expect(plan).toContainText("Little Sam");
  await expect(plan.locator("li")).toHaveCount(3); // two people + total
  // Back to back: one barber for both, times differ.
  await flow.getByTestId("mode-back-to-back").click();
  await flow.getByTestId("group-slot").first().click();
  const names = await plan.locator("li:not(.group-total) .avatar").allTextContents();
  expect(new Set(names).size).toBe(1);
  await flow.getByTestId("group-next").click();
  await flow.getByLabel("Your name").fill("Dad Example");
  await flow.getByLabel("Mobile number").fill("07700 900777");
  await flow.getByTestId("group-next").click();
  await expect(flow.getByRole("heading", { name: "Check and confirm." })).toBeVisible();
  await expect(flow.getByText(/onwards with/)).toBeVisible();
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await flow.getByTestId("group-confirm").click();
  const done = flow.getByTestId("group-confirmed");
  await expect(done).toBeVisible();
  await expect(done).toContainText("2 of 2 visits saved");
  await expect(done.getByTestId("group-summary").locator("li")).toHaveCount(2);
  await expect(done).toContainText("Little Sam");
  expect(errors).toEqual([]);
  // Customer area: sign in as the booker; both visits listed, the second labelled for Little Sam.
  const A = `${origin}/api/public/shops/${slug}/account`;
  const st = await (await page.request.post(`${A}/start`, { headers: { Origin: origin }, data: { phone: "07700900777" } })).json();
  await page.request.post(`${A}/verify`, { headers: { Origin: origin }, data: { phone: "07700900777", code: st.sandbox_code } });
  await page.goto(`/${slug}/me`);
  const list = page.getByTestId("upcoming-list");
  await expect(list.locator("li")).toHaveCount(2);
  await expect(list).toContainText("for Little Sam");
  await expect(list).toContainText("group");
});

test("owner sees attendee and group badge in the appointment panel and calendar", async ({ page }) => {
  const { slug, c, w, P } = await openFixtureShop(page).then(async (f) => {
    const c = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
    const w = await (await page.request.get(base + "/workspace")).json();
    return { slug: f.slug, c, w, P: `${origin}/api/public/shops/${f.slug}` };
  });
  const date = weekdayAhead();
  const av = await (await c.get(`${P}/group-availability?date=${date}&members=${encodeURIComponent(`${w.services[0].id}:any:;${w.services[0].id}:any:`)}`)).json();
  const pick = av.together.find((o: { available: boolean }) => o.available);
  const g = await (
    await c.post(`${P}/group-bookings`, {
      data: {
        request_id: crypto.randomUUID(),
        customer_name: "Panel Parent",
        phone: "07700900666",
        email: "",
        notes: "",
        date,
        members: pick.assignment.map((a: { staff_id: string; start_min: number }, i: number) => ({ attendee_name: i ? "Kid Panel" : "", staff_id: a.staff_id, service_id: w.services[0].id, addon_ids: [], start_min: a.start_min, quote: av.quotes[i] })),
      },
    })
  ).json();
  expect(g.bookings).toHaveLength(2);
  await page.getByLabel("Appointment date").fill(date);
  const card = page.getByRole("button", { name: /Kid Panel/ }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("group-badge")).toBeVisible();
  await expect(page.getByTestId("panel-attendee")).toContainText("Kid Panel");
  await expect(page.getByRole("heading", { name: /Kid Panel/ })).toBeVisible();
  void slug;
});
