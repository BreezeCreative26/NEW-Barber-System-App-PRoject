// A shop's own CSV uploads (campaign list + customer import) accept more than the 16 KB that small
// JSON forms are limited to. This used to answer 413 "Request is too large" for any real list.
import { test, expect } from "@playwright/test";
import { newShop, base } from "./shop";

const rows = (n: number) => Array.from({ length: n }, (_, i) => `Person ${i},07700 ${String(900000 + i).slice(-6)},person${i}@list.test`);

test("shop campaign list upload and customer import take files bigger than 16 KB", async () => {
  test.setTimeout(90000);
  const { r } = await newShop("Csv size shop");
  const w = await (await r.get(base + "/workspace")).json();
  const slug = `sz-${crypto.randomUUID().slice(0, 8)}`;
  expect((await r.put(base + "/shop/online", { data: { slug, online_booking: 1, lead_time_min: 60, booking_window_days: 42, version: w.shop.version } })).status()).toBe(200);

  const csv = ["Name,Mobile,Email", ...rows(900)].join("\r\n"); // ~45 KB
  expect(csv.length).toBeGreaterThan(16384);
  const up = await r.post(base + "/announcements/contacts", { data: { csv } });
  expect(up.status(), await up.text()).toBe(200);
  expect((await up.json()).added).toBe(900);

  // The campaign then carries every uploaded person's id in its preview/send body (~38 bytes each).
  const ids = (await up.json()).ids as string[];
  expect(JSON.stringify(ids).length).toBeGreaterThan(16384);
  const prev = await r.post(base + "/announcements/preview", { data: { channel: "EMAIL", audience: "NONE", contact_ids: ids } });
  expect(prev.status(), await prev.text()).toBe(200);
  expect((await prev.json()).email).toBe(900);

  const imp = await r.post(base + "/customers/import", { data: { csv } });
  expect(imp.status(), await imp.text()).toBe(201);

  // Still refuses anything beyond the cap, with a clear message rather than a crash.
  const huge = await r.post(base + "/announcements/contacts", { data: { csv: "a".repeat(5 * 1024 * 1024) } });
  expect([400, 413]).toContain(huge.status());
});
