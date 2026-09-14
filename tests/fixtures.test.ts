import { describe, expect, it } from "vitest";
import app from "../src/index";
import {
  addons,
  appointmentsFor,
  dateLabel,
  datePlus,
  money,
  previewSlotReason,
  quote,
  SAMPLE_DAY,
  services,
  time,
  validateDetails,
} from "../src/client/fixtures";

describe("honest preview route boundaries", () => {
  it("redirects the root to the admin preview", async () => {
    const r = await app.request("/");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/preview/admin");
  });
  it.each(["admin", "book", "barber"])(
    "serves the %s shell with noindex and no-store",
    async (surface) => {
      const r = await app.request(`/preview/${surface}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const body = await r.text();
      expect(body).toContain("noindex,nofollow");
      expect(body).toContain("/static/app.js");
      expect(body).toContain('lang="en"');
    },
  );
  it("rejects unknown preview and business API routes", async () => {
    expect((await app.request("/preview/unknown")).status).toBe(404);
    expect(
      (await app.request("/api/bookings", { method: "POST" })).status,
    ).toBe(404);
  });
  it("declares that payments and persistence are absent", async () => {
    const r = await app.request("/api/health");
    expect(await r.json()).toEqual({
      status: "ok",
      mode: "design-preview",
      livePayments: false,
      persistence: false,
    });
  });
});

describe("fixture quote and form helpers — not production money rules", () => {
  it("counts deposit once", () => {
    const q = quote("combo", "jay", ["towel"]);
    expect(q.price).toBe(4600);
    expect(q.deposit).toBe(500);
    expect(q.price - q.deposit).toBe(4100);
    expect(q.duration).toBe(70);
  });
  it("applies the sample Jay fade override only to that combination", () => {
    expect(quote("fade", "jay", []).price).toBe(3500);
    expect(quote("fade", "marcus", []).price).toBe(3200);
    expect(quote("cut", "jay", []).override).toBe(0);
  });
  it("does not double-count duplicate or unknown extras", () => {
    expect(quote("cut", "jay", ["towel", "towel", "unknown"]).price).toBe(3200);
  });
  it("remains integer pence for all fixture combinations", () => {
    for (const s of services) {
      const q = quote(
        s.id,
        "jay",
        addons.map((a) => a.id),
      );
      expect(Number.isInteger(q.price)).toBe(true);
      expect(q.price).toBeGreaterThan(q.deposit);
    }
  });
  it("formats money without silently dropping pence", () => {
    expect(money(2800)).toBe("£28");
    expect(money(2850)).toBe("£28.50");
  });
  it.each(["07700 900123", "+44 7700 900123"])(
    "accepts the reserved fictional mobile %s",
    (phone) => {
      expect(
        validateDetails({ name: "Jamie Taylor", phone, email: "", notes: "" }),
      ).toEqual({});
    },
  );
  it("rejects invalid fields and overlong notes", () => {
    expect(
      Object.keys(
        validateDetails({
          name: " ",
          phone: "123",
          email: "bad",
          notes: "x".repeat(501),
        }),
      ).sort(),
    ).toEqual(["email", "name", "notes", "phone"]);
  });
  it("does not require email", () => {
    expect(
      validateDetails({
        name: "Jamie",
        phone: "07700900123",
        email: "",
        notes: "",
      }).email,
    ).toBeUndefined();
  });
});

describe("sample availability — no reservation or concurrency guarantee", () => {
  it("moves dates consistently using UTC dates", () => {
    expect(datePlus(SAMPLE_DAY, 1)).toBe("2026-09-15");
    expect(datePlus("2026-09-30", 1)).toBe("2026-10-01");
    expect(dateLabel(SAMPLE_DAY)).toBe("Monday 14 September");
  });
  it("formats minutes", () => {
    expect(time(630)).toBe("10:30");
    expect(time(540)).toBe("09:00");
  });
  it("blocks Sunday", () => {
    expect(appointmentsFor("2026-09-20")).toEqual([]);
    expect(previewSlotReason("2026-09-20", "jay", 900, 30)).toBe("Shop closed");
  });
  it("blocks past sample time", () => {
    expect(previewSlotReason(SAMPLE_DAY, "jay", 540, 30)).toBe(
      "Past sample time",
    );
  });
  it("covers service plus buffer against sample appointments", () => {
    expect(previewSlotReason(SAMPLE_DAY, "jay", 675, 30)).toBe(
      "Already booked",
    );
  });
  it("blocks lunch even when a service would start beforehand", () => {
    expect(previewSlotReason(SAMPLE_DAY, "jay", 750, 30)).toBe("Lunch break");
  });
  it("allows a valid afternoon example", () => {
    expect(previewSlotReason(SAMPLE_DAY, "jay", 990, 30)).toBe("");
  });
  it("checks the closing buffer", () => {
    expect(previewSlotReason(SAMPLE_DAY, "jay", 1050, 30)).toBe(
      "Outside opening hours",
    );
  });
});
