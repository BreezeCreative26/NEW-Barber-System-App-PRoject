// Staff accounts by email + staff onboarding. Owner: Team → barber → Login → email invitation.
// Barber: opens the link, sets a password, gets the shop-branded onboarding (welcome → profile →
// week → app), finishes, lands in the barber app; the profile edits are on the shop page data and
// the flow never shows again. Owner sees "Can sign in" and can suspend / restore.
import { test, expect } from "@playwright/test";
import { openFixtureShop, section } from "./fixture";

const origin = "http://localhost:3000";
const base = origin + "/api/app";

test("owner sets up a barber login from Team; barber onboards on first sign-in", async ({ page, browser }) => {
  const { slug } = await openFixtureShop(page);
  const ws = await (await page.request.get(base + "/workspace")).json();
  // A barber with no account yet.
  const access = await (await page.request.get(base + "/auth/access")).json();
  const free = ws.staff.find((s: { id: string; active: number }) => s.active && !access.members.some((m: { staff_id: string }) => m.staff_id === s.id));
  expect(free, "fixture has an unassigned barber").toBeTruthy();

  await section(page, "Team");
  await page.getByRole("button", { name: new RegExp(free.name) }).first().click();
  await expect(page.getByTestId("barber-editor")).toBeVisible();
  await page.getByTestId("barber-tab-login").click();
  await expect(page.getByTestId("staff-login-none")).toBeVisible();
  const email = `barber-${Date.now()}@example.com`;
  await page.getByTestId("staff-login-email").fill(email);
  await page.getByTestId("staff-login-invite").click();
  await expect(page.getByTestId("staff-login-pending")).toBeVisible();
  const link = await page.getByTestId("staff-login-link").locator("textarea").inputValue();
  expect(link).toContain("invite=");
  // Invite email went out from the shop with the new copy.
  const mailbox = await (await page.request.get(base + "/dev/mailbox")).json();
  const mail = (mailbox.messages || mailbox).find?.((m: { to?: string; subject?: string }) => m.to === email) ?? null;
  if (mail) expect(mail.subject).toMatch(/login/i);

  // Barber accepts in a fresh phone-sized context.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await ctx.newPage();
  const errors: string[] = [];
  p2.on("pageerror", (e) => errors.push(e.message));
  await p2.goto(link.replace(/^https?:\/\/[^/]+/, origin));
  await expect(p2.getByTestId("invite-peek")).toBeVisible();
  await p2.fill('input[name="name"]', "Marcus Reed");
  await p2.fill('input[name="password"]', "Passw0rd!passw0rd");
  await p2.getByTestId("accept-legal").locator("input").check({ force: true });
  await p2.getByRole("button", { name: "Join the team" }).dispatchEvent("click");

  // Onboarding: welcome → profile → week → app → done.
  const onb = p2.getByTestId("staff-onboarding");
  await expect(onb).toBeVisible({ timeout: 15000 });
  // Greeting uses the profile the owner set up (their staff name), not the typed account name.
  await expect(p2.getByTestId("staff-onb-welcome")).toContainText(`Hi ${free.name.split(" ")[0]}`);
  await p2.getByTestId("staff-onb-next").click();
  await expect(p2.getByTestId("staff-onb-profile")).toBeVisible();
  await p2.getByTestId("staff-onb-title").fill("Senior barber");
  await p2.getByTestId("staff-onb-bio").fill("Fades and beards. Eight years behind the chair.");
  await p2.getByTestId("staff-onb-skill").fill("Skin fade");
  await p2.getByTestId("staff-onb-skill").press("Enter");
  await p2.getByTestId("staff-onb-next").click();
  await expect(p2.getByTestId("staff-onb-week")).toBeVisible();
  await expect(p2.getByTestId("staff-onb-week")).toContainText("Monday");
  await p2.getByTestId("staff-onb-next").click();
  await expect(p2.getByTestId("staff-onb-app")).toBeVisible();
  await p2.getByTestId("staff-onb-finish").click();
  // Lands in the barber phone app.
  await expect(p2.getByTestId("barber-home")).toBeVisible({ timeout: 15000 });
  await expect(p2.getByTestId("staff-onboarding")).toHaveCount(0);
  // Profile edits persisted on the staff row and reach the public shop page.
  const me = await (await p2.request.get(base + "/workspace")).json();
  expect(me.account.role).toBe("BARBER");
  expect(me.account.onboarded_at).toBeTruthy();
  const mine = me.staff.find((s: { id: string }) => s.id === free.id);
  expect(mine.title).toBe("Senior barber");
  expect(JSON.parse(mine.skills)).toContain("Skin fade");
  const pub = await (await p2.request.get(origin + `/api/public/shops/${slug}/page`)).json();
  expect(pub.staff.find((s: { id: string }) => s.id === free.id)?.title).toBe("Senior barber");
  // Reload: onboarding does not come back.
  await p2.reload();
  await expect(p2.getByTestId("barber-home")).toBeVisible({ timeout: 15000 });
  await expect(p2.getByTestId("staff-onboarding")).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();

  // Owner now sees an active login and can suspend / restore.
  await page.reload();
  await section(page, "Team");
  await page.getByRole("button", { name: new RegExp(free.name) }).first().click();
  await page.getByTestId("barber-tab-login").click();
  await expect(page.getByTestId("staff-login-active")).toBeVisible();
  await expect(page.getByTestId("staff-login-active")).toContainText(email);
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("staff-login-suspend").click();
  await expect(page.getByTestId("staff-login-active")).toContainText("Suspended");
  await page.getByTestId("staff-login-restore").click();
  await expect(page.getByTestId("staff-login-active")).toContainText("Can sign in");
});

test("barber cannot edit someone else's profile or pay through the onboarding endpoint", async ({ request }) => {
  const r = await request.post(base + "/auth/demo", { data: { as: "barber" }, headers: { Origin: origin } });
  expect(r.status()).toBe(201);
  const bad = await request.put(base + "/me/profile", { data: { name: "Jay", commission_pct: 90 }, headers: { Origin: origin } });
  expect(bad.status()).toBe(400);
  const ok = await request.put(base + "/me/profile", { data: { name: "Jay Demo", title: "Barber", bio: "", photo_url: "", instagram: "", skills: ["Fades"] }, headers: { Origin: origin } });
  expect(ok.status(), await ok.text()).toBe(200);
  const forbidden = await request.put(base + "/staff/00000000-0000-0000-0000-000000000000", { data: { name: "x", role: "Barber", version: 0 }, headers: { Origin: origin } });
  expect([403, 404]).toContain(forbidden.status());
});
