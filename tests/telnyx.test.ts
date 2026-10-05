import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { applyTelnyxEvent, telnyxOn, telnyxSend, telnyxWebhookOk } from "../src/server/telnyx";

const env = { TELNYX_API_KEY: "KEYtest", TELNYX_MESSAGING_PROFILE_ID: "mp_1", TELNYX_FROM: "+447700900000" };

afterEach(() => vi.unstubAllGlobals());

describe("telnyxSend", () => {
  it("is off without an API key", () => {
    expect(telnyxOn({})).toBe(false);
    expect(telnyxOn(env)).toBe(true);
  });
  it("posts to /v2/messages with the profile and the shop's alphanumeric sender", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: { id: "msg_1" } }), { status: 200 });
    });
    const r = await telnyxSend("+447911123456", "See you at 10:00", { alphaSender: "Northline", e: env });
    expect(r).toEqual({ ok: true, provider: "telnyx", id: "msg_1" });
    expect(calls[0].url).toBe("https://api.telnyx.com/v2/messages");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer KEYtest");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({ to: "+447911123456", text: "See you at 10:00", from: "Northline", messaging_profile_id: "mp_1", type: "SMS" });
  });
  it("falls back to the number when no alpha sender, and marks bad numbers permanent", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.from).toBe("+447700900000");
      return new Response(JSON.stringify({ errors: [{ code: "40300", title: "Invalid destination" }] }), { status: 400 });
    });
    const r = await telnyxSend("+441234", "hi", { e: env });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.permanent).toBe(true);
      expect(r.error).toContain("40300");
    }
  });
  it("retries on transient failure (5xx is not permanent)", async () => {
    vi.stubGlobal("fetch", async () => new Response("gateway", { status: 502 }));
    const r = await telnyxSend("+447911123456", "hi", { e: env });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBeFalsy();
  });
});

describe("telnyxWebhookOk", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw32 = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  const body = JSON.stringify({ data: { event_type: "message.finalized" } });
  it("accepts a valid Ed25519 signature and rejects tampering or stale timestamps", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");
    expect(telnyxWebhookOk(body, sig, ts, { TELNYX_PUBLIC_KEY: raw32 })).toBe(true);
    expect(telnyxWebhookOk(body + " ", sig, ts, { TELNYX_PUBLIC_KEY: raw32 })).toBe(false);
    expect(telnyxWebhookOk(body, sig, String(Number(ts) - 3600), { TELNYX_PUBLIC_KEY: raw32 })).toBe(false);
    expect(telnyxWebhookOk(body, undefined, ts, { TELNYX_PUBLIC_KEY: raw32 })).toBe(false);
  });
  it("rejects when no public key is configured", () => {
    expect(telnyxWebhookOk(body, undefined, undefined, {})).toBe(false);
  });
});

// Tiny fake of the D1-style DB the app uses: records SQL + binds, answers a couple of lookups.
function fakeDb() {
  const ran: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async run() { ran.push({ sql, args }); return { meta: { changes: 1 } }; },
        async first<T>() { ran.push({ sql, args }); return (sql.includes("FROM notifications") ? { shop_id: "shop_a" } : null) as T | null; },
        async all<T>() { return { results: [] as T[] }; },
      };
      return stmt;
    },
  };
  return { db: db as never, ran };
}

describe("applyTelnyxEvent", () => {
  it("marks a delivered message and records carrier failures against the outbox row", async () => {
    const { db, ran } = fakeDb();
    const ok = await applyTelnyxEvent(db, { data: { event_type: "message.finalized", payload: { id: "msg_1", direction: "outbound", to: [{ phone_number: "+447911123456", status: "delivered" }] } } });
    expect(ok).toBe("delivered");
    expect(ran[0].sql).toContain("status_note='Delivered'");
    expect(ran[0].args).toEqual(["msg_1"]);
    const bad = await applyTelnyxEvent(db, { data: { event_type: "message.finalized", payload: { id: "msg_2", direction: "outbound", to: [{ phone_number: "+447911123456", status: "delivery_failed" }], errors: [{ code: "40008", title: "Unsupported destination" }] } } });
    expect(bad).toBe("failed");
    expect(ran[1].sql).toContain("status='FAILED'");
    expect(ran[1].args[0]).toContain("40008");
  });
  it("an inbound STOP opts the number out and is stored against the shop that last texted it", async () => {
    const { db, ran } = fakeDb();
    const r = await applyTelnyxEvent(db, { data: { event_type: "message.received", payload: { id: "in_1", direction: "inbound", text: "STOP", from: { phone_number: "+447911123456" } } } }, 1000);
    expect(r).toBe("inbound");
    expect(ran.some((x) => x.sql.includes("INSERT INTO wa_optouts") && x.args[0] === "447911123456")).toBe(true);
    const stored = ran.find((x) => x.sql.includes("INSERT INTO wa_inbound"));
    expect(stored?.args).toEqual(["in_1", "shop_a", "447911123456", "STOP", "in_1", 1000]);
  });
  it("START lifts the opt-out; unknown events are ignored", async () => {
    const { db, ran } = fakeDb();
    await applyTelnyxEvent(db, { data: { event_type: "message.received", payload: { id: "in_2", direction: "inbound", text: "start", from: { phone_number: "+447911123456" } } } });
    expect(ran.some((x) => x.sql.includes("DELETE FROM wa_optouts"))).toBe(true);
    expect(await applyTelnyxEvent(db, { data: { event_type: "something.else", payload: { id: "x" } } })).toBe("ignored");
    expect(await applyTelnyxEvent(db, null)).toBe("ignored");
  });
});

describe("telnyxSend alpha sender fallback", () => {
  it("retries from the platform number when Telnyx refuses the alphanumeric sender", async () => {
    const froms: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      froms.push(body.from);
      if (body.from === "Northline") return new Response(JSON.stringify({ errors: [{ code: "40303", title: "Alphanumeric sender not permitted" }] }), { status: 400 });
      return new Response(JSON.stringify({ data: { id: "msg_num" } }), { status: 200 });
    });
    const r = await telnyxSend("+447911123456", "hi", { alphaSender: "Northline", e: env });
    expect(r).toEqual({ ok: true, provider: "telnyx", id: "msg_num" });
    expect(froms).toEqual(["Northline", "+447700900000"]);
  });
  it("does not retry for destination problems (bad number stays permanent)", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => { n++; return new Response(JSON.stringify({ errors: [{ code: "40300", title: "Invalid destination" }] }), { status: 400 }); });
    const r = await telnyxSend("+441", "hi", { alphaSender: "Northline", e: env });
    expect(n).toBe(1);
    expect(r.ok).toBe(false);
  });
});
