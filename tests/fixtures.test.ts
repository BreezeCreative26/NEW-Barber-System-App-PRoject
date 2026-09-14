import { describe, expect, it } from "vitest";
import app from "../src/index";
import { dateLabel, datePlus, money, time } from "../src/client/fixtures";

describe("app route boundaries", () => {
  it("redirects the root to the workspace", async () => {
    const r = await app.request("/");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/workspace");
  });
  it("serves the workspace shell with noindex and no-store", async () => {
    const r = await app.request("/workspace");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.text();
    expect(body).toContain("noindex,nofollow");
    expect(body).toContain("/static/app.js");
    expect(body).toContain('lang="en"');
  });
  it("has no fixture preview surfaces and rejects unknown business API routes", async () => {
    for (const p of ["/preview/admin", "/preview/book", "/preview/barber"])
      expect((await app.request(p)).status).toBe(404);
    expect((await app.request("/api/bookings", { method: "POST" })).status).toBe(404);
  });
  it("declares that payments and persistence are absent without sandbox bindings", async () => {
    const r = await app.request("/api/health");
    expect(await r.json()).toEqual({
      status: "ok",
      mode: "static",
      livePayments: false,
      persistence: false,
    });
  });
});

describe("formatting helpers", () => {
  it("formats money without silently dropping pence", () => {
    expect(money(2800)).toBe("£28");
    expect(money(2850)).toBe("£28.50");
  });
  it("moves dates consistently using UTC dates", () => {
    expect(datePlus("2026-09-14", 1)).toBe("2026-09-15");
    expect(datePlus("2026-09-30", 1)).toBe("2026-10-01");
    expect(dateLabel("2026-09-14")).toBe("Monday 14 September");
  });
  it("formats minutes", () => {
    expect(time(630)).toBe("10:30");
    expect(time(540)).toBe("09:00");
  });
});
