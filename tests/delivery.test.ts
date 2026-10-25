// Customer delivery: what the email/SMS providers are told, and how failures are classified.
// These run against stubbed provider endpoints, so they prove our side of the contract:
// the right payload goes out, a misconfigured sender is reported (and retried, not binned),
// and a bad recipient is not retried forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverDirect, emailStatus, isTestSender } from "../src/server/messaging";
import { teamUrl } from "../src/server/hosts";

const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as never; // deliverDirect only reads the db for the STOP list
const KEYS = ["RESEND_API_KEY", "MAIL_FROM", "TELNYX_API_KEY", "CLICKSEND_USERNAME", "CLICKSEND_API_KEY", "TWILIO_ACCOUNT_SID", "APP_ORIGIN", "APP_ROOT_HOST"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } vi.unstubAllGlobals(); });

describe("emailStatus: 'live' is not 'customers receive it'", () => {
  it("no key → preview mailbox, not customer-ready", () => {
    const s = emailStatus({});
    expect(s).toMatchObject({ provider: "mailbox", customer_ready: false });
    expect(s.warning).toMatch(/preview mailbox/);
  });
  it("key but no MAIL_FROM → resend, NOT customer-ready, says why", () => {
    const s = emailStatus({ RESEND_API_KEY: "re_x" });
    expect(s).toMatchObject({ provider: "resend", customer_ready: false });
    expect(s.warning).toMatch(/verified in Resend/);
  });
  it("key + Resend's shared test sender → still not customer-ready", () => {
    expect(emailStatus({ RESEND_API_KEY: "re_x", MAIL_FROM: "onboarding@resend.dev" }).customer_ready).toBe(false);
    expect(emailStatus({ RESEND_API_KEY: "re_x", MAIL_FROM: "foliyo <onboarding@resend.dev>" }).customer_ready).toBe(false);
    expect(isTestSender("Bookings <bookings@resend.dev>")).toBe(true);
  });
  it("key + an address on your own domain → customer-ready", () => {
    expect(emailStatus({ RESEND_API_KEY: "re_x", MAIL_FROM: "bookings@mail.foliyo.co.uk" })).toMatchObject({ provider: "resend", customer_ready: true, warning: "" });
  });
});

describe("Resend send", () => {
  const send = () => deliverDirect(db, { channel: "EMAIL", to: "customer@example.com", subject: "Your booking", body: "See you at 10:00", html: "<p>See you at 10:00</p>", fromName: "Northline Barbers", replyTo: "hello@northline.test" });

  it("posts shop-named sender, recipient, subject, html + text, reply-to, with a timeout", async () => {
    process.env.RESEND_API_KEY = "re_test"; process.env.MAIL_FROM = "bookings@mail.foliyo.co.uk";
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: "em_1" }), { status: 200 }); });
    const r = await send();
    expect(r).toEqual({ ok: true, provider: "resend", id: "em_1" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal); // a hung provider can't wedge the queue
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ from: "Northline Barbers <bookings@mail.foliyo.co.uk>", to: ["customer@example.com"], subject: "Your booking", html: "<p>See you at 10:00</p>", text: "See you at 10:00", reply_to: "hello@northline.test" });
  });
  it("403 (sender not verified) is OUR setup problem: retryable, never discarded", async () => {
    process.env.RESEND_API_KEY = "re_test";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ name: "validation_error", message: "You can only send testing emails to your own email address" }), { status: 403 }));
    const r = await send();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ provider: "resend", permanent: false });
  });
  it("422 (bad recipient) is permanent so it stops retrying", async () => {
    process.env.RESEND_API_KEY = "re_test"; process.env.MAIL_FROM = "bookings@mail.foliyo.co.uk";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Invalid `to` field" }), { status: 422 }));
    expect(await send()).toMatchObject({ ok: false, permanent: true });
  });
  it("a network failure comes back as a retryable failure, not a throw", async () => {
    process.env.RESEND_API_KEY = "re_test"; process.env.MAIL_FROM = "bookings@mail.foliyo.co.uk";
    vi.stubGlobal("fetch", async () => { throw new Error("socket hang up"); });
    expect(await send()).toMatchObject({ ok: false, provider: "resend", error: "socket hang up" });
  });
  it("with no key nothing leaves the building: dev mailbox", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    expect(await send()).toMatchObject({ ok: true, provider: "mailbox" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("ClickSend text", () => {
  const text = (to: string) => deliverDirect(db, { channel: "SMS", to, body: "Northline: see you at 10:00", fromName: "Northline Barbers" });
  it("normalises 07… to +44…, sends under the shop's name, with a timeout", async () => {
    process.env.CLICKSEND_USERNAME = "u"; process.env.CLICKSEND_API_KEY = "k";
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ data: { messages: [{ status: "SUCCESS", message_id: "cs_1" }] } }), { status: 200 }); });
    expect(await text("07700 900123")).toEqual({ ok: true, provider: "clicksend", id: "cs_1" });
    const m = JSON.parse(calls[0].init.body as string).messages[0];
    expect(m).toMatchObject({ to: "+447700900123", from: "Northline" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
  it("a landline / junk number is refused locally and permanently, without spending a text", async () => {
    process.env.CLICKSEND_USERNAME = "u"; process.env.CLICKSEND_API_KEY = "k";
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    expect(await text("12345")).toMatchObject({ ok: false, permanent: true });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("teamUrl: staff links always point at the shop's own address", () => {
  it("production: https://<slug>.<root>/workspace, whatever host served the request", () => {
    process.env.APP_ORIGIN = "https://foliyo.co.uk";
    expect(teamUrl("northline", "https://other.foliyo.co.uk")).toBe("https://northline.foliyo.co.uk/workspace");
    expect(teamUrl("northline", "https://foliyo.co.uk", "/verify?token=abc")).toBe("https://northline.foliyo.co.uk/verify?token=abc");
  });
  it("no slug yet → falls back to the request origin rather than a broken host", () => {
    process.env.APP_ORIGIN = "https://foliyo.co.uk";
    expect(teamUrl(null, "https://foliyo.co.uk")).toBe("https://foliyo.co.uk/workspace");
  });
  it("local dev (no root host) keeps the request origin", () => {
    expect(teamUrl("northline", "http://localhost:3000")).toBe("http://localhost:3000/workspace");
  });
});

describe("marketing consent at the provider edge", () => {
  it("marketing email carries one-click List-Unsubscribe headers (RFC 8058); booking email does not", async () => {
    process.env.RESEND_API_KEY = "re_test"; process.env.MAIL_FROM = "bookings@mail.foliyo.co.uk";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ id: "em_1" }), { status: 200 }); });
    await deliverDirect(db, { channel: "EMAIL", to: "a@example.com", subject: "News", body: "hi", html: '<p>Hi</p><a href="https://demo.foliyo.co.uk/u/c/abcdefghijklmnop1234">Unsubscribe</a>', fromName: "Demo Cuts" });
    expect(bodies[0].headers).toEqual({ "List-Unsubscribe": "<https://demo.foliyo.co.uk/u/c/abcdefghijklmnop1234>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });
  it("a number that replied STOP is never texted, whichever SMS provider is configured", async () => {
    process.env.CLICKSEND_USERNAME = "u"; process.env.CLICKSEND_API_KEY = "k";
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const optedOut = { prepare: () => ({ bind: () => ({ first: async () => ({ x: 1 }) }) }) } as never;
    const r = await deliverDirect(optedOut, { channel: "SMS", to: "07700900123", body: "News from Demo Cuts", fromName: "Demo Cuts" });
    expect(r).toMatchObject({ ok: false, permanent: true });
    expect(f).not.toHaveBeenCalled();
  });
});
