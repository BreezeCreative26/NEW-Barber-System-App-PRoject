// Shop booking terms (versioned, re-accepted when they change) and logo tone detection at upload.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import type { WorkspaceData } from "../src/server/domain";
import { base, origin, newShop } from "./shop";

const pub = origin + "/api/public";
const customer = () => request.newContext({ extraHTTPHeaders: { Origin: origin } });
function futureDate(days = 8) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function onlineShop(terms = "") {
  const { r } = await newShop("Terms Test Shop");
  let w: WorkspaceData = await (await r.get(base + "/workspace")).json();
  const slug = `terms-${crypto.randomUUID().slice(0, 12)}`;
  const res = await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, terms_text: terms, version: w.shop.version } });
  expect(res.status(), await res.text()).toBe(200);
  w = await (await r.get(base + "/workspace")).json();
  return { r, w, slug };
}
const identity = () => {
  const n = String(100000 + Math.floor(Math.random() * 899999));
  return { name: "Terms Customer", phone: `07700 ${n}`, email: `terms-${n}@example.test`, password: "Unique fictional test password 438!" };
};
async function freeSlot(c: APIRequestContext, slug: string, w: WorkspaceData, date: string) {
  const staff = w.staff[0].id, service = w.services[0].id;
  const avail = await (await c.get(`${pub}/shops/${slug}/availability?date=${date}&staff_id=${staff}&service_id=${service}`)).json();
  const free = avail.slots.find((x: { reason?: string }) => !x.reason);
  expect(free).toBeTruthy();
  return { staff, service, start_min: free.start_min as number, quote: avail.quote };
}

test("terms: version bumps on change; sign-up must accept; booking asks again after an update; unchanged saves keep the version", async () => {
  const { r, w, slug } = await onlineShop("Arrive five minutes early.\n\nNo-shows are charged in full.");
  expect(w.shop.terms_version).toBe(1);
  // Public shop advertises them.
  const shop = await (await r.get(`${pub}/shops/${slug}`)).json();
  expect(shop.shop.terms).toEqual(expect.objectContaining({ version: 1 }));
  expect(shop.shop.terms.text).toContain("No-shows");

  // Sign-up without accepting → 400; with the version → 201 and session says accepted v1.
  const c = await customer();
  const id = identity();
  const noTick = await c.post(`${pub}/shops/${slug}/account/register`, { data: { ...id } });
  expect(noTick.status()).toBe(400);
  const ok = await c.post(`${pub}/shops/${slug}/account/register`, { data: { ...id, accept_terms_version: 1 } });
  expect(ok.status(), await ok.text()).toBe(201);
  expect((await (await c.get(`${pub}/shops/${slug}/account/session`)).json()).terms_accepted).toBe(1);

  // Booking with v1 accepted: no tick needed.
  const date = futureDate(8);
  const s1 = await freeSlot(c, slug, w, date);
  const b1 = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: s1.staff, service_id: s1.service, customer_name: id.name, phone: id.phone, email: id.email, date, start_min: s1.start_min, quote: s1.quote } });
  expect(b1.status(), await b1.text()).toBe(201);

  // Owner saves the same settings again: version stays at 1.
  let w2: WorkspaceData = await (await r.get(base + "/workspace")).json();
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, terms_text: w2.shop.terms_text, version: w2.shop.version } })).status()).toBe(200);
  w2 = await (await r.get(base + "/workspace")).json();
  expect(w2.shop.terms_version).toBe(1);

  // Owner changes the wording: v2. Next booking without a fresh tick → 409 terms_required.
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, terms_text: "Arrive ten minutes early.", version: w2.shop.version } })).status()).toBe(200);
  w2 = await (await r.get(base + "/workspace")).json();
  expect(w2.shop.terms_version).toBe(2);
  const date2 = futureDate(9);
  const s2 = await freeSlot(c, slug, w2, date2);
  const blocked = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: s2.staff, service_id: s2.service, customer_name: id.name, phone: id.phone, email: id.email, date: date2, start_min: s2.start_min, quote: s2.quote } });
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).error).toBe("terms_required");
  // Ticking the stale version does not count.
  const stale = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: s2.staff, service_id: s2.service, customer_name: id.name, phone: id.phone, email: id.email, date: date2, start_min: s2.start_min, quote: s2.quote, accept_terms_version: 1 } });
  expect(stale.status()).toBe(409);
  // Accepting v2 books and sticks.
  const fresh = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: s2.staff, service_id: s2.service, customer_name: id.name, phone: id.phone, email: id.email, date: date2, start_min: s2.start_min, quote: s2.quote, accept_terms_version: 2 } });
  expect(fresh.status(), await fresh.text()).toBe(201);
  expect((await (await c.get(`${pub}/shops/${slug}/account/session`)).json()).terms_accepted).toBe(2);

  // Clearing the terms: version 0, nothing asked.
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, terms_text: "", version: w2.shop.version } })).status()).toBe(200);
  const w3: WorkspaceData = await (await r.get(base + "/workspace")).json();
  expect(w3.shop.terms_version).toBe(0);
  expect((await (await c.get(`${pub}/shops/${slug}`)).json()).shop.terms).toBeNull();
  await c.dispose();
});

test("shop without terms: sign-up and booking never ask", async () => {
  const { w, slug } = await onlineShop();
  expect(w.shop.terms_version ?? 0).toBe(0);
  const c = await customer();
  const id = identity();
  expect((await c.post(`${pub}/shops/${slug}/account/register`, { data: id })).status()).toBe(201);
  const date = futureDate(8);
  const s = await freeSlot(c, slug, w, date);
  const b = await c.post(`${pub}/shops/${slug}/bookings`, { data: { request_id: crypto.randomUUID(), staff_id: s.staff, service_id: s.service, customer_name: id.name, phone: id.phone, email: id.email, date, start_min: s.start_min, quote: s.quote } });
  expect(b.status(), await b.text()).toBe(201);
  await c.dispose();
});

test("logo tone: a white mark reads as light, an ink mark as dark, a colour mark as colour; the shop page stores it and the brand carries it", async () => {
  const sharp = (await import("sharp")).default;
  const mark = async (rgb: [number, number, number]) => {
    // 240×240 transparent canvas with a solid disc in the given colour.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><circle cx="120" cy="120" r="90" fill="rgb(${rgb.join(",")})"/></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  };
  const { r, w, slug } = await onlineShop();
  const upload = async (buf: Buffer, name: string) => {
    const res = await r.post(base + "/media", { multipart: { kind: "logo", file: { name, mimeType: "image/png", buffer: buf } } });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).media as { url: string; tone: string };
  };
  const white = await upload(await mark([255, 255, 255]), "white.png");
  const ink = await upload(await mark([20, 20, 24]), "ink.png");
  const colour = await upload(await mark([220, 60, 40]), "red.png");
  expect(white.tone).toBe("light");
  expect(ink.tone).toBe("dark");
  expect(colour.tone).toBe("colour");

  // Saving the page with the white logo stores logo_tone and the public brand carries it.
  const page = (await (await r.get(base + "/shop/page")).json()).page;
  const body = {
    strapline: "", about: "", cover_url: "", logo_url: white.url, gallery: [], phone: "", email: "", instagram: "", map_url: "", transport_note: "", policy_text: "",
    sections: ["hero", "services"], accent: "ink", theme: { font: "modern", mode: "dark", corners: "soft", hero: "editorial", logo: "auto" }, google_review_url: "", published: 1, version: Number(page.version ?? 0),
  };
  const saved = await r.put(base + "/shop/page", { data: body });
  expect(saved.status(), await saved.text()).toBe(200);
  expect((await saved.json()).page.logo_tone).toBe("light");
  const shop = await (await r.get(`${pub}/shops/${slug}`)).json();
  expect(shop.shop.brand.logo_tone).toBe("light");
  // Workspace carries it for the dashboard brand.
  const ws: WorkspaceData & { logo_tone?: string } = await (await r.get(base + "/workspace")).json();
  expect(ws.logo_tone).toBe("light");
  // The shell for the shop page embeds it too (boot screen + first render).
  // (The root host redirects shop paths to the sub-domain, which the sandbox cannot resolve; ask
  // the way the edge does, with the shop-host header.)
  const html = await (await r.get(`${origin}/`, { headers: { host: `${slug}.localhost:3000` }, maxRedirects: 0 })).text();
  expect(html).toContain('"logo_tone":"light"');
  // A light logo on a dark theme is not flipped on the boot screen.
  expect(html).not.toContain('class="boot-logo flip"');
  void w;
});
