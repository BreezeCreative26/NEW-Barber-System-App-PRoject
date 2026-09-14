import {
  test,
  expect,
  request,
  type APIRequestContext,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import type { WorkspaceData } from "../src/server/domain";
const origin = "http://localhost:3000",
  base = origin + "/api/sandbox";
const password = "Unique fictional test password 438!";
const email = () => `${crypto.randomUUID()}@example.test`;
async function client() {
  return request.newContext({ extraHTTPHeaders: { Origin: origin } });
}
async function workspace(r: APIRequestContext): Promise<WorkspaceData> {
  const response = await r.get(base + "/workspace");
  expect(response.status()).toBe(200);
  return response.json();
}
async function owner() {
  const r = await client();
  expect(
    (
      await r.post(base + "/session", {
        data: { name: "Fictional account test shop" },
      })
    ).status(),
  ).toBe(201);
  const before = await workspace(r),
    legacy = await r.storageState(),
    address = email();
  const result = await r.post(base + "/auth/register", {
    data: { name: "Fictional Owner", email: address, password },
  });
  expect(result.status(), await result.text()).toBe(201);
  return { r, before, legacy, address };
}
async function invite(
  r: APIRequestContext,
  w: WorkspaceData,
  role = "BARBER",
  index = 0,
) {
  const address = email();
  const response = await r.post(base + "/auth/invites", {
    data: { email: address, role, staff_id: w.staff[index].id },
  });
  expect(response.status(), await response.text()).toBe(201);
  return { ...(await response.json()), address } as {
    token: string;
    id: string;
    address: string;
  };
}
async function accept(i: { token: string; address: string }) {
  const r = await client();
  const result = await r.post(base + "/auth/accept", {
    data: {
      token: i.token,
      name: "Fictional Staff",
      email: i.address,
      password,
    },
  });
  expect(result.status(), await result.text()).toBe(201);
  return r;
}
function date() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 8);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function booking(r: APIRequestContext, w: WorkspaceData, index: number) {
  const service = w.services[0];
  const data = {
    request_id: crypto.randomUUID(),
    staff_id: w.staff[index].id,
    service_id: service.id,
    date: date(),
    start_min: 540,
    customer_name: `Fictional customer ${index}`,
    phone: "07700900123",
    source: "TEST_BOOKING",
    quote: { service_version: service.version, shop_version: w.shop.version },
  };
  const response = await r.post(base + "/bookings", { data });
  expect(response.status(), await response.text()).toBe(201);
  return { data, booking: (await response.json()).booking };
}
const mutations = [
  ["POST", "/register"],
  ["POST", "/login"],
  ["POST", "/logout"],
  ["POST", "/invites"],
  ["POST", "/invites/:id/revoke"],
  ["POST", "/accept"],
  ["PUT", "/members/:id"],
  ["POST", "/password"],
  ["POST", "/demo"],
];
test("account mutation inventory enforces origin and anonymous authorization", async () => {
  const source = readFileSync("src/server/accounts.ts", "utf8");
  expect(
    [
      ...source.matchAll(
        /accounts\.(post|put|patch|delete)\(\s*["']([^"']+)["']/g,
      ),
    ]
      .map((m) => [m[1].toUpperCase(), m[2]])
      .sort(),
  ).toEqual([...mutations].sort());
  const anonymous = await client();
  for (const [method, path] of mutations) {
    for (const badOrigin of ["", "https://evil.example"]) {
      expect(
        (
          await anonymous.fetch(
            base + "/auth" + path.replace(":id", crypto.randomUUID()),
            { method, headers: { Origin: badOrigin }, data: {} },
          )
        ).status(),
      ).toBe(403);
    }
    if (!["/login", "/logout", "/accept", "/demo"].includes(path))
      expect(
        (
          await anonymous.fetch(
            base + "/auth" + path.replace(":id", crypto.randomUUID()),
            { method, data: {} },
          )
        ).status(),
      ).toBe(401);
  }
  expect(
    (
      await anonymous.post(base + "/auth/login", {
        data: { email: email(), password, shop_id: "injected" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await anonymous.post(base + "/auth/login", {
        data: JSON.stringify({ email: email(), password: "é".repeat(9000) }),
        headers: { "Content-Type": "application/json" },
      })
    ).status(),
  ).toBe(413);
  await anonymous.dispose();
});
test("owner claim preserves shop and retires legacy capability; login and password revoke sessions", async () => {
  const { r, before, legacy, address } = await owner();
  expect((await workspace(r)).shop).toEqual(before.shop);
  expect((await workspace(r)).staff).toEqual(before.staff);
  const cookies = (await r.storageState()).cookies;
  const session = cookies.find((c) => c.name === "barbershop_account")!;
  expect(
    session.httpOnly && session.secure && session.sameSite === "Strict",
  ).toBeTruthy();
  expect(cookies.some((c) => c.name === "barbershop_test_session")).toBeFalsy();
  const old = await request.newContext({
    storageState: legacy,
    extraHTTPHeaders: { Origin: origin },
  });
  expect((await old.get(base + "/workspace")).status()).toBe(401);
  const second = await client();
  expect(
    (
      await second.post(base + "/auth/login", {
        data: { email: address.toUpperCase(), password },
      })
    ).status(),
  ).toBe(200);
  expect((await workspace(second)).shop.id).toBe(before.shop.id);
  expect(
    (
      await r.post(base + "/auth/password", {
        data: { current_password: password, password: password + " new" },
      })
    ).status(),
  ).toBe(200);
  expect((await second.get(base + "/workspace")).status()).toBe(401);
  expect(
    (
      await second.post(base + "/auth/login", {
        data: { email: address, password },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await second.post(base + "/auth/login", {
        data: { email: address, password: password + " new" },
      })
    ).status(),
  ).toBe(200);
  expect((await r.post(base + "/auth/logout", { data: {} })).status()).toBe(
    200,
  );
  expect((await r.get(base + "/workspace")).status()).toBe(401);
  await Promise.all([r, old, second].map((r) => r.dispose()));
});
test("barber reads and writes are assigned scoped including replay and availability", async () => {
  const { r, before: w } = await owner();
  const own = await booking(r, w, 0),
    other = await booking(r, w, 1);
  const staff = await accept(await invite(r, w));
  const view = await workspace(staff);
  expect(view.staff.map((s) => s.id)).toEqual([w.staff[0].id]);
  expect(view.bookings.map((b) => b.id)).toEqual([own.booking.id]);
  expect(view.hours.every((h) => h.staff_id === w.staff[0].id)).toBeTruthy();
  expect(view.audit).toEqual([]);
  expect((await staff.get(base + `/bookings?date=${date()}`)).status()).toBe(
    200,
  );
  expect(
    (await (await staff.get(base + `/bookings?date=${date()}`)).json())
      .bookings,
  ).toHaveLength(1);
  expect(
    (
      await staff.get(
        base + `/bookings?date=${date()}&staff_id=${w.staff[1].id}`,
      )
    ).status(),
  ).toBe(403);
  expect(
    (await staff.get(base + `/bookings/${other.booking.id}`)).status(),
  ).toBe(403);
  expect(
    (await staff.post(base + "/bookings", { data: other.data })).status(),
  ).toBe(403);
  expect(
    (
      await staff.get(
        base +
          `/availability?date=${date()}&staff_id=${w.staff[1].id}&service_id=${w.services[0].id}`,
      )
    ).status(),
  ).toBe(403);
  expect(
    (
      await staff.post(base + `/bookings/${other.booking.id}/status`, {
        data: { status: "CANCELLED", version: 0, reason: "Test cancellation" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await staff.post(base + `/bookings/${own.booking.id}/status`, {
        data: { status: "CANCELLED", version: 0, reason: "Test cancellation" },
      })
    ).status(),
  ).toBe(200);
  expect((await staff.put(base + "/shop", { data: {} })).status()).toBe(403);
  expect((await staff.post(base + "/staff", { data: {} })).status()).toBe(403);
  expect((await staff.get(base + "/auth/access")).status()).toBe(403);
  const anotherShop = await owner();
  expect(
    (
      await staff.get(
        base +
          `/bookings/${(await booking(anotherShop.r, anotherShop.before, 0)).booking.id}`,
      )
    ).status(),
  ).toBe(404);
  await Promise.all([r, staff, anotherShop.r].map((r) => r.dispose()));
});
for (const role of ["MANAGER", "RECEPTION"])
  test(`${role} has operational scope without owner access`, async () => {
    const { r, before: w } = await owner();
    const staff = await accept(await invite(r, w, role));
    expect((await workspace(staff)).staff).toHaveLength(2);
    await booking(staff, w, 1);
    expect((await staff.post(base + "/services", { data: {} })).status()).toBe(
      role === "MANAGER" ? 400 : 403,
    );
    for (const path of ["/invites", "/members/" + crypto.randomUUID()])
      expect(
        (
          await staff.fetch(base + "/auth" + path, {
            method: path === "/invites" ? "POST" : "PUT",
            data: {},
          })
        ).status(),
      ).toBe(403);
    expect((await staff.get(base + "/auth/access")).status()).toBe(403);
    await Promise.all([r, staff].map((r) => r.dispose()));
  });
test("invites reject revoked replaced wrong-email and replayed tokens", async () => {
  const { r, before: w } = await owner();
  const old = await invite(r, w),
    current = await invite(r, w);
  const anon = await client();
  const body = {
    token: old.token,
    email: old.address,
    name: "Fictional staff",
    password,
  };
  expect(
    (await anon.post(base + "/auth/accept", { data: body })).status(),
  ).toBe(400);
  expect(
    (
      await anon.post(base + "/auth/accept", {
        data: { ...body, token: current.token },
      })
    ).status(),
  ).toBe(400);
  const staff = await accept(current);
  expect(
    (
      await anon.post(base + "/auth/accept", {
        data: { ...body, token: current.token, email: current.address },
      })
    ).status(),
  ).toBe(400);
  const i = await invite(r, w, "BARBER", 1);
  expect(
    (
      await r.post(base + `/auth/invites/${i.id}/revoke`, { data: {} })
    ).status(),
  ).toBe(200);
  expect(
    (
      await anon.post(base + "/auth/accept", {
        data: { ...body, token: i.token, email: i.address },
      })
    ).status(),
  ).toBe(400);
  const access = await (await r.get(base + "/auth/access")).text();
  expect(access).not.toContain("token_hash");
  expect(access).not.toContain("password");
  expect(access).not.toContain(current.token);
  await Promise.all([r, anon, staff].map((r) => r.dispose()));
});
test("role change suspension stale versions and owner protection revoke only intended sessions", async () => {
  const { r, before: w } = await owner();
  const i = await invite(r, w),
    staff = await accept(i);
  let access = await (await r.get(base + "/auth/access")).json();
  const m = access.members.find((m: any) => m.role === "BARBER"),
    o = access.members.find((m: any) => m.role === "OWNER");
  expect(
    (
      await r.put(base + `/auth/members/${m.id}`, {
        data: { role: "RECEPTION", active: 1, version: m.version },
      })
    ).status(),
  ).toBe(200);
  expect((await staff.get(base + "/workspace")).status()).toBe(401);
  expect(
    (
      await staff.post(base + "/auth/login", {
        data: { email: i.address, password },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await r.put(base + `/auth/members/${m.id}`, {
        data: { role: "BARBER", active: 0, version: 0 },
      })
    ).status(),
  ).toBe(409);
  expect((await staff.get(base + "/workspace")).status()).toBe(200);
  expect(
    (
      await r.put(base + `/auth/members/${o.id}`, {
        data: { role: "BARBER", active: 0, version: 0 },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await r.put(base + `/auth/members/${m.id}`, {
        data: { role: "RECEPTION", active: 0, version: 1 },
      })
    ).status(),
  ).toBe(200);
  expect((await staff.get(base + "/workspace")).status()).toBe(401);
  expect(
    (
      await staff.post(base + "/auth/login", {
        data: { email: i.address, password },
      })
    ).status(),
  ).toBe(401);
  const legacy = await client();
  await legacy.post(base + "/session", { data: { name: "Other legacy shop" } });
  const mixed = await staff.storageState();
  mixed.cookies.push(...(await legacy.storageState()).cookies);
  const bypass = await request.newContext({
    storageState: mixed,
    extraHTTPHeaders: { Origin: origin },
  });
  expect((await bypass.get(base + "/workspace")).status()).toBe(401);
  expect(
    (
      await bypass.post(base + "/session", { data: { name: "Bypass" } })
    ).status(),
  ).toBe(401);
  expect(
    (await workspace(r)).audit.filter((a) => a.action === "MEMBERSHIP_UPDATED"),
  ).toHaveLength(2);
  await Promise.all([r, staff, legacy, bypass].map((r) => r.dispose()));
});
test("competing invite accepts create one membership and competing password changes have one winner", async () => {
  const { r, before: w, address } = await owner();
  const i = await invite(r, w),
    a = await client(),
    b = await client();
  const data = {
    token: i.token,
    email: i.address,
    name: "Fictional concurrent staff",
    password,
  };
  const accepted = await Promise.all(
    [a, b].map((c) => c.post(base + "/auth/accept", { data })),
  );
  expect(accepted.filter((x) => x.status() === 201)).toHaveLength(1);
  expect(
    accepted.every((x) => [201, 400, 409].includes(x.status())),
  ).toBeTruthy();
  const second = await client();
  expect(
    (
      await second.post(base + "/auth/login", {
        data: { email: address, password },
      })
    ).status(),
  ).toBe(200);
  const changed = await Promise.all(
    [r, second].map((c, index) =>
      c.post(base + "/auth/password", {
        data: { current_password: password, password: password + index },
      }),
    ),
  );
  expect(changed.filter((x) => x.status() === 200)).toHaveLength(1);
  expect(
    changed.every((x) => [200, 401, 409].includes(x.status())),
  ).toBeTruthy();
  const winner = changed.findIndex((x) => x.status() === 200);
  expect(
    (
      await a.post(base + "/auth/login", {
        data: { email: address, password: password + winner },
      })
    ).status(),
  ).toBe(200);
  const after = await workspace(a);
  expect(
    after.audit.filter((x) => x.action === "PASSWORD_CHANGED"),
  ).toHaveLength(1);
  expect(
    after.audit.filter((x) => x.action === "STAFF_INVITATION_ACCEPTED"),
  ).toHaveLength(1);
  await Promise.all([r, a, b, second].map((c) => c.dispose()));
});
test("cross-shop access edits fail and inactive profiles cannot sign in", async () => {
  const x = await owner(),
    y = await owner();
  const i = await invite(x.r, x.before),
    staff = await accept(i);
  const access = await (await x.r.get(base + "/auth/access")).json();
  const m = access.members.find((m: any) => m.role === "BARBER");
  expect(
    (
      await y.r.put(base + `/auth/members/${m.id}`, {
        data: { role: "MANAGER", active: 1, version: 0 },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await y.r.post(base + "/auth/invites", {
        data: {
          email: email(),
          staff_id: x.before.staff[1].id,
          role: "BARBER",
        },
      })
    ).status(),
  ).toBe(404);
  const s = x.before.staff[0];
  expect(
    (
      await x.r.put(base + `/staff/${s.id}`, {
        data: { name: s.name, role: s.role, active: 0, version: s.version },
      })
    ).status(),
  ).toBe(200);
  expect((await staff.get(base + "/workspace")).status()).toBe(401);
  expect(
    (
      await staff.post(base + "/auth/login", {
        data: { email: i.address, password },
      })
    ).status(),
  ).toBe(401);
  await Promise.all([x.r, y.r, staff].map((c) => c.dispose()));
});
test("login throttle bounds repeated attempts without disclosing account existence", async () => {
  const r = await client(),
    address = email();
  for (let n = 0; n < 12; n++)
    expect(
      (
        await r.post(base + "/auth/login", {
          data: { email: address, password },
        })
      ).status(),
    ).toBe(401);
  const blocked = await r.post(base + "/auth/login", {
    data: { email: address, password },
  });
  expect(blocked.status()).toBe(429);
  expect(blocked.headers()["retry-after"]).toBe("600");
  await r.dispose();
});
for (const width of [320, 390, 768, 844, 1024, 1440, 1920])
  test(`account UI claim invite accept and assigned workspace at ${width}px`, async ({
    page,
    browser,
  }, info) => {
    await page.setViewportSize({
      width,
      height: width === 844 ? 390 : width === 1024 ? 600 : 900,
    });
    await page.goto(origin + "/workspace");
    await page.getByText("Start a blank test shop").click();
    await page
      .getByRole("button", { name: "Create test workspace", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "New booking", exact: true }),
    ).toBeVisible();
    const w = await (await page.request.get(base + "/workspace")).json();
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    await page
      .getByLabel("Your name", { exact: true })
      .fill("Fictional UI Owner");
    await page.getByLabel("Account email").fill(email());
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Create owner account", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "New booking", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Team access", exact: true }),
    ).toBeVisible();
    const staffEmail = email();
    await page.getByLabel("Staff profile").selectOption(w.staff[0].id);
    await page.getByLabel("Invitation email").fill(staffEmail);
    await page
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    const link = await page.getByLabel("Staff invitation link").inputValue();
    expect(link).toContain("#invite=");
    await expect(page.locator(".workspace-error")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBeTruthy();
    expect(
      (await new AxeBuilder({ page }).include(".workspace").analyze())
        .violations,
    ).toEqual([]);
    await page
      .getByRole("button", { name: "Hide invitation link", exact: true })
      .click();
    await page.screenshot({
      path: info.outputPath(`accounts-${width}.png`),
      fullPage: true,
    });
    const staffContext = await browser.newContext({
      viewport: { width, height: width === 844 ? 390 : 900 },
    });
    const staffPage = await staffContext.newPage();
    await staffPage.goto(link);
    await expect(staffPage).toHaveURL(origin + "/workspace");
    await staffPage
      .getByLabel("Your name", { exact: true })
      .fill("Fictional UI Barber");
    await staffPage.getByLabel("Account email").fill(staffEmail);
    await staffPage.getByLabel("Password", { exact: true }).fill(password);
    await staffPage
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await expect(
      staffPage.getByRole("button", { name: "New booking", exact: true }),
    ).toBeVisible();
    // Barbers see Appointments, their own Insights and Customers, and Accounts only.
    await expect(
      staffPage
        .getByRole("navigation", { name: "Workspace sections" })
        .getByRole("button"),
    ).toHaveText(["Appointments", "Insights", "Customers", "Accounts"]);
    const assigned = await (
      await staffPage.request.get(base + "/workspace")
    ).json();
    expect(assigned.staff.map((s: any) => s.id)).toEqual([w.staff[0].id]);
    expect(
      (
        await new AxeBuilder({ page: staffPage })
          .include(".workspace")
          .analyze()
      ).violations,
    ).toEqual([]);
    await staffPage.screenshot({
      path: info.outputPath(`assigned-${width}.png`),
      fullPage: true,
    });
    await staffPage.reload();
    await expect(
      staffPage.getByRole("button", { name: "New booking", exact: true }),
    ).toBeVisible();
    await staffPage
      .getByRole("button", { name: "Accounts", exact: true })
      .click();
    await expect(
      staffPage.getByRole("heading", { name: "Invite staff", exact: true }),
    ).toHaveCount(0);
    await staffPage
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await expect(
      staffPage.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await staffContext.close();
  });

test("same-origin guard accepts forwarded proxy hosts and refuses foreign origins", async () => {
  const r = await request.newContext();
  // Bare mismatch is refused.
  const foreign = await r.post(base + "/session", {
    headers: { Origin: "https://evil.example" },
    data: { name: "Origin probe" },
  });
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).error).toBe("origin_forbidden");
  // Missing origin is refused.
  expect((await r.post(base + "/session", { data: { name: "Origin probe" } })).status()).toBe(403);
  // A development proxy that rewrites Host but forwards the public host is accepted.
  const forwarded = await r.post(base + "/session", {
    headers: {
      Origin: "https://preview.example.dev",
      "X-Forwarded-Host": "preview.example.dev",
      "X-Forwarded-Proto": "https",
    },
    data: { name: "Origin probe" },
  });
  expect(forwarded.status()).toBe(201);
  // Forwarded host that does not match the Origin is still refused.
  const mismatch = await request.newContext();
  const bad = await mismatch.post(base + "/session", {
    headers: { Origin: "https://evil.example", "X-Forwarded-Host": "preview.example.dev" },
    data: { name: "Origin probe" },
  });
  expect(bad.status()).toBe(403);
  // HTTPS terminating proxy: browser Origin is https, worker sees http on the same host.
  const scheme = await request.newContext();
  expect(
    (await scheme.post(base + "/session", { headers: { Origin: "https://localhost:3000" }, data: { name: "Origin probe" } })).status(),
  ).toBe(201);
  // Browser-asserted same-origin fetch is trusted even when Origin is rewritten.
  const fetchSite = await request.newContext();
  expect(
    (await fetchSite.post(base + "/session", { headers: { Origin: "https://wrapper.example", "Sec-Fetch-Site": "same-origin" }, data: { name: "Origin probe" } })).status(),
  ).toBe(201);
  // Cross-site fetch is refused even if Origin matches nothing.
  const cross = await request.newContext();
  expect(
    (await cross.post(base + "/session", { headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, data: { name: "Origin probe" } })).status(),
  ).toBe(403);
  await Promise.all([r.dispose(), mismatch.dispose(), scheme.dispose(), fetchSite.dispose(), cross.dispose()]);
});

test("standard demo account: one-click owner/barber sign-in, fixed credentials, idempotent rebuild", async () => {
  test.setTimeout(90000);
  const owner = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  // Other suites edit the shared demo shop; start from the deterministic seed so counts are exact.
  const opened = await owner.post(base + "/auth/demo", { data: { rebuild: true } });
  expect(opened.status(), await opened.text()).toBe(201);
  const body = await opened.json();
  expect(body.email).toBe("owner@demo.test");
  expect(body.slug).toBe("demo");
  const w = await (await owner.get(base + "/workspace")).json();
  expect(w.shop.name).toBe("Demo Barbershop");
  expect(w.account.role).toBe("OWNER");
  expect(w.staff).toHaveLength(3);
  expect(w.services).toHaveLength(8);
  expect(w.addons.length).toBeGreaterThanOrEqual(4);
  // History spans the past and future and includes every status and both channels.
  const insights = await (await owner.get(base + "/insights?days=90")).json();
  const statuses = new Set(insights.by_status.map((s: any) => s.status));
  expect(statuses.has("COMPLETED")).toBe(true);
  expect(statuses.has("NO_SHOW")).toBe(true);
  expect(insights.upcoming.n).toBeGreaterThan(5);
  expect(insights.waitlist_open).toBe(2);
  const range = await (
    await owner.get(base + `/bookings/range?from=${w.today}&to=${plus(w.today, 14)}`)
  ).json();
  expect(range.bookings.some((b: any) => b.series_id)).toBe(true);
  expect(range.bookings.some((b: any) => b.channel === "ONLINE")).toBe(true);
  // Password login works from a fresh browser.
  const fresh = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect(
    (await fresh.post(base + "/auth/login", { data: { email: "owner@demo.test", password: "Demo1234!" } })).status(),
  ).toBe(200);
  expect((await (await fresh.get(base + "/workspace")).json()).shop.id).toBe(body.shop_id);
  // Public booking page is live for the demo slug.
  expect((await fresh.get(origin + "/api/public/shops/demo")).status()).toBe(200);
  // Barber sign-in is scoped to Jay only.
  const barber = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  expect((await barber.post(base + "/auth/demo", { data: { as: "barber" } })).status()).toBe(201);
  const bw = await (await barber.get(base + "/workspace")).json();
  expect(bw.account.role).toBe("BARBER");
  expect(bw.account.email).toBe("jay@demo.test");
  expect(bw.bookings.every((b: any) => b.staff_id === bw.account.staff_id)).toBe(true);
  // Rebuild replaces the shop with a fresh id; the old one is retired and the emails reused.
  const rebuilt = await owner.post(base + "/auth/demo", { data: { rebuild: true } });
  expect(rebuilt.status()).toBe(201);
  const after = await rebuilt.json();
  expect(after.shop_id).not.toBe(body.shop_id);
  expect(
    (await fresh.post(base + "/auth/login", { data: { email: "owner@demo.test", password: "Demo1234!" } })).status(),
  ).toBe(200);
  expect((await (await fresh.get(base + "/workspace")).json()).shop.id).toBe(after.shop_id);
  // Isolated fixture copies never touch the shared demo: private slug/emails, same seed.
  const fx = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const fixture = await (await fx.post(base + "/auth/demo", { data: { fixture: true } })).json();
  expect(fixture.shop_id).not.toBe(after.shop_id);
  expect(fixture.slug).toMatch(/^demo-[0-9a-f]{8}$/);
  expect(fixture.email).toMatch(/^owner-[0-9a-f]{8}@demo\.test$/);
  const fw = await (await fx.get(base + "/workspace")).json();
  expect(fw.shop.id).toBe(fixture.shop_id);
  expect(fw.services).toHaveLength(8);
  expect((await fresh.get(origin + "/api/public/shops/demo")).status()).toBe(200);
  expect((await (await fresh.get(base + "/workspace")).json()).shop.id).toBe(after.shop_id);
  await fx.dispose();
  // Invalid options are rejected.
  expect((await owner.post(base + "/auth/demo", { data: { as: "ceo" } })).status()).toBe(400);
  await Promise.all([owner.dispose(), fresh.dispose(), barber.dispose()]);
});

test("entry screen is the single project hub: owner, barber, customer booking, manage link; blank shop is secondary", async ({ page }) => {
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Open the demo shop" })).toBeVisible();
  const hub = page.getByRole("list", { name: "Pages in this project" });
  await expect(hub.getByRole("listitem")).toHaveCount(4);
  await expect(hub).toContainText("Owner / admin");
  await expect(hub).toContainText("Barber");
  await expect(hub).toContainText("Customer booking");
  await expect(hub).toContainText("Customer manage link");
  await expect(page.getByTestId("open-customer")).toHaveAttribute("href", "/book/demo");
  // No fixture preview pages any more.
  for (const p of ["/preview/admin", "/preview/book", "/preview/barber"])
    expect((await page.request.get(p)).status()).toBe(404);
  expect((await page.request.get("/", { maxRedirects: 0 })).headers()["location"]).toBe("/workspace");
  // The blank-shop path is folded away until asked for.
  await expect(page.getByRole("button", { name: "Create test workspace", exact: true })).not.toBeVisible();
  await expect(page.getByLabel("Account email")).toHaveValue("owner@demo.test");
  await page.getByRole("button", { name: "Open as owner", exact: true }).click();
  await expect(page.getByText("Demo Barbershop").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "New booking", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waitlist" })).toBeVisible();
});
function plus(date: string, n: number) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
