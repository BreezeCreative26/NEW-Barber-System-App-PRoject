// The same money paths through the real HTTP app: a second copy of the built app is started on its own
// port with a fake Stripe (test key + STRIPE_API_BASE), so the signed webhook, the void endpoint and the
// settings guard run exactly as they do in production. Needs `npm run build` first. No real Stripe call.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

const PORT = 3011;
const ORIGIN = `http://localhost:${PORT}`;
const SECRET = "whsec_test_fake_secret";
process.env.TEST_ORIGIN = ORIGIN; // tests/shop.ts reads this when it is first imported (below)
let server: ChildProcess;
let fakeUrl = "";
let fake: Awaited<ReturnType<typeof import("./support/fake-stripe").startFakeStripe>>;
let shopMod: typeof import("./shop");
let db: ReturnType<typeof import("../src/db/client").makeDb>;
let stripeMod: typeof import("../src/server/stripe");

const sign = (body: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
};
const hook = (evt: object) => {
  const body = JSON.stringify(evt);
  return fetch(`${ORIGIN}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sign(body), "content-type": "application/json" }, body });
};

beforeAll(async () => {
  const { startFakeStripe } = await import("./support/fake-stripe");
  fake = await startFakeStripe();
  fakeUrl = fake.url;
  const { makeDb } = await import("../src/db/client");
  const envFile = existsSync(".env.local") ? ".env.local" : ".env";
  const dbUrl = process.env.DATABASE_URL || readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
  db = makeDb(dbUrl, { max: 2 } as never);
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_API_BASE = fakeUrl;
  stripeMod = await import("../src/server/stripe");
  shopMod = await import("./shop");
  server = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_API_BASE: fakeUrl, STRIPE_WEBHOOK_SECRET: SECRET, APP_ORIGIN: ORIGIN },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${ORIGIN}/api/public/build`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("app did not start");
}, 90000);
afterAll(async () => { server?.kill(); await fake?.close(); });

async function world() {
  const { newShop, base, origin } = shopMod;
  const s = await newShop("HTTP money shop");
  const w = await (await s.r.get(base + "/workspace")).json();
  const staff = w.staff.find((x: any) => x.active);
  const service = w.services.find((x: any) => x.price_pence === 2800);
  let booking: any;
  for (let i = 2; i < 12 && !booking; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const av = await (await s.r.get(base + `/availability?date=${date}&staff_id=${staff.id}&service_id=${service.id}`)).json();
    const slot = av.slots.find((x: any) => !x.reason);
    if (!slot) continue;
    const res = await s.r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: service.id, date, start_min: slot.start_min, customer_name: "Hook Customer", phone: "07700900321", source: "TEST_BOOKING", quote: av.quote } });
    expect(res.status(), await res.text()).toBe(201);
    booking = (await res.json()).booking;
  }
  const set = (status: string, paid: number, pi: string, extra = "") => db.prepare(`UPDATE bookings SET deposit_status=?, deposit_paid_pence=?, stripe_payment_intent=? ${extra} WHERE id=?`).bind(status, paid, pi, booking.id).run();
  const row = async () => (await db.prepare("SELECT * FROM bookings WHERE id=?").bind(booking.id).first<any>())!;
  return { s, shopId: s.shop_id, booking, set, row, base, origin };
}
const session = (shopId: string, bookingId: string, pi: string) => ({ id: "evt_" + crypto.randomUUID(), type: "checkout.session.completed", data: { object: { id: "cs_" + crypto.randomUUID().slice(0, 6), payment_status: "paid", payment_intent: pi, amount_total: 1000, client_reference_id: bookingId, metadata: { shop_id: shopId, booking_id: bookingId } } } });
const refunds = () => fake.calls.filter((c) => c.path === "/v1/refunds");

describe("Stripe webhook", () => {
  it("rejects an unsigned or wrongly signed event", async () => {
    const r = await fetch(`${ORIGIN}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" }, body: "{}" });
    expect(r.status).toBe(400);
  });

  it("a paid checkout confirms the booking, and the same event delivered twice is processed once", async () => {
    const w = await world();
    await w.set("PENDING", 0, "", ", deposit_hold_until=" + (Date.now() + 600000));
    const evt = session(w.shopId, w.booking.id, "pi_hook_ok");
    expect((await hook(evt)).status).toBe(200);
    const b = await w.row();
    expect(b.deposit_status).toBe("PAID");
    expect(b.stripe_payment_intent).toBe("pi_hook_ok");
    const audits = () => db.prepare("SELECT COUNT(*)::int AS n FROM audit_events WHERE entity_id=? AND action='DEPOSIT_PAID'").bind(w.booking.id).first<{ n: number }>();
    expect((await audits())!.n).toBe(1);
    const dup = await (await hook(evt)).json();
    expect(dup.duplicate).toBe(true);
    expect((await audits())!.n).toBe(1);
  });

  it("if processing fails the event is answered 500 and NOT remembered, so Stripe's redelivery still works", async () => {
    const w = await world();
    // Customer cancelled; their payment arrives late; the automatic refund fails once.
    await w.set("EXPIRED", 0, "", ", status='CANCELLED', deposit_hold_until=NULL");
    const evt = session(w.shopId, w.booking.id, "pi_hook_retry");
    await fetch(`${fakeUrl}/__fail?code=api_connection_error`);
    const first = await hook(evt);
    expect(first.status).toBe(500);
    expect((await db.prepare("SELECT 1 FROM stripe_events WHERE id=?").bind(evt.id).first())).toBeNull();
    expect((await w.row()).deposit_status).toBe("EXPIRED"); // nothing half-done
    await fetch(`${fakeUrl}/__fail`); // Stripe is back
    const second = await hook(evt); // same event id, redelivered
    expect(second.status).toBe(200);
    const b = await w.row();
    expect(b.deposit_status).toBe("REFUNDED");
    expect(b.status).toBe("CANCELLED");
    expect(refunds().filter((c) => c.body.payment_intent === "pi_hook_retry").length).toBeGreaterThanOrEqual(1);
  });

  it("a refund made in the Stripe dashboard (charge.refunded) closes the deposit on the booking", async () => {
    const w = await world();
    await w.set("PAID", 1000, "pi_hook_dash");
    const r = await hook({ id: "evt_" + crypto.randomUUID(), type: "charge.refunded", data: { object: { id: "ch_x", payment_intent: "pi_hook_dash", amount: 1000, amount_refunded: 1000, refunded: true } } });
    expect(r.status).toBe(200);
    expect((await w.row()).deposit_status).toBe("REFUNDED");
  });
});

describe("voiding a card payment", () => {
  it("refunds the customer first; if Stripe refuses, the payment stays live", async () => {
    const w = await world();
    await w.set("PAID", 1000, "pi_void_1");
    // A kept deposit: the visit was cancelled inside the policy window, so the deposit sits in the ledger.
    await w.set("PAID", 1000, "pi_void_1", ", status='CANCELLED'");
    const bk = await w.row();
    const shop = (await db.prepare("SELECT * FROM shops WHERE id=?").bind(w.shopId).first<any>())!;
    await stripeMod.keepDepositInLedger(db, shop, bk, "test", "policy");
    const pay = (await db.prepare("SELECT id FROM payments WHERE booking_id=? AND voided_at IS NULL").bind(w.booking.id).first<{ id: string }>())!;
    expect(pay).toBeTruthy();

    await fetch(`${fakeUrl}/__fail?code=api_connection_error`);
    const bad = await w.s.r.post(w.base + `/payments/${pay.id}/void`, { headers: { Origin: w.origin }, data: { reason: "customer complained" } });
    expect(bad.status()).toBe(409);
    expect((await db.prepare("SELECT voided_at FROM payments WHERE id=?").bind(pay.id).first<any>()).voided_at).toBeNull();
    expect((await w.row()).deposit_status).toBe("PAID");

    await fetch(`${fakeUrl}/__fail`);
    const ok = await w.s.r.post(w.base + `/payments/${pay.id}/void`, { headers: { Origin: w.origin }, data: { reason: "customer complained" } });
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).refunded).toBe(true);
    expect((await db.prepare("SELECT voided_at FROM payments WHERE id=?").bind(pay.id).first<any>()).voided_at).not.toBeNull();
    expect((await w.row()).deposit_status).toBe("REFUNDED");
  });
});

describe("switching card deposits on", () => {
  it("is refused until the shop's payout account is verified, and allowed once it is", async () => {
    const w = await world();
    const settings = { deposits_online: 1, deposit_hold_min: 15, payment_mode: "DEPOSIT", payout_tier: "STANDARD", payrun_auto: "OFF", payrun_reserve_bps: 0, pay_show_owner_share: 1 };
    await db.prepare("UPDATE shops SET deposit_pence=1000 WHERE id=?").bind(w.shopId).run();
    const no = await w.s.r.put(w.base + "/shop/payments", { headers: { Origin: w.origin }, data: settings });
    expect(no.status()).toBe(409);
    expect(await no.text()).toMatch(/payout account/i);
    const now = Date.now();
    await db.prepare("INSERT INTO connected_accounts(id,shop_id,owner_type,owner_id,details_submitted,charges_enabled,payouts_enabled,created_at,updated_at) VALUES(?,?,'SHOP',?,1,1,1,?,?)").bind("acct_" + crypto.randomUUID().slice(0, 8), w.shopId, w.shopId, now, now).run();
    const yes = await w.s.r.put(w.base + "/shop/payments", { headers: { Origin: w.origin }, data: settings });
    expect(yes.status(), await yes.text()).toBe(200);
    const view = await (await w.s.r.get(w.base + "/shop/payments")).json();
    expect(view.payouts_ready).toBe(true);
    expect(view.reconciliation).toBeTruthy();
  });
});
