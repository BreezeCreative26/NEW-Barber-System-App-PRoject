// The money paths, against the real local Postgres (through the real API for setup) and a fake Stripe:
// refunds + retry, late payment on a lapsed hold, kept deposits in the ledger, a pay run whose payout
// account is not ready staying APPROVED, transfer reversals when a settled deposit is refunded, and
// refunds made in the Stripe dashboard. No real Stripe call is made anywhere.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { newShop, base, origin } from "./shop";
import { startFakeStripe, type FakeStripe } from "./support/fake-stripe";
import { makeDb } from "../src/db/client";
import { keepDepositInLedger, markDepositPaid, refundDeposit, retryDepositRefunds } from "../src/server/stripe";
import { executeRun, handleConnectEvent } from "../src/server/payouts";
import type { Shop, StoredBooking } from "../src/server/domain";

const envFile = existsSync(".env.local") ? ".env.local" : ".env";
const dbUrl = process.env.DATABASE_URL || readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
const db = makeDb(dbUrl, { max: 2 } as never);
let fake: FakeStripe;
const saved = { key: process.env.STRIPE_SECRET_KEY, base: process.env.STRIPE_API_BASE };

beforeAll(async () => {
  fake = await startFakeStripe();
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_API_BASE = fake.url;
}, 20000);
afterAll(async () => {
  process.env.STRIPE_SECRET_KEY = saved.key; process.env.STRIPE_API_BASE = saved.base;
  if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY;
  if (saved.base === undefined) delete process.env.STRIPE_API_BASE;
  await fake.close();
});

// A shop with one booking in the future (made through the owner API), then its deposit state set directly.
async function world(deposit: { status: string; paid?: number; pi?: string } = { status: "PAID", paid: 1000 }) {
  const s = await newShop("Money test shop");
  const w = await (await s.r.get(base + "/workspace")).json();
  const staff = w.staff.find((x: any) => x.active) ;
  const service = w.services.find((x: any) => x.price_pence === 2800);
  let booking: any;
  for (let i = 2; i < 12 && !booking; i++) {
    const d = new Date(w.today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const av = await (await s.r.get(base + `/availability?date=${date}&staff_id=${staff.id}&service_id=${service.id}`)).json();
    const slot = av.slots.find((x: any) => !x.reason);
    if (!slot) continue;
    const res = await s.r.post(base + "/bookings", { headers: { Origin: origin }, data: { request_id: crypto.randomUUID(), staff_id: staff.id, service_id: service.id, date, start_min: slot.start_min, customer_name: "Money Customer", phone: "07700900123", source: "TEST_BOOKING", quote: av.quote } });
    expect(res.status(), await res.text()).toBe(201);
    booking = (await res.json()).booking;
  }
  expect(booking).toBeTruthy();
  const pi = deposit.pi ?? `pi_${crypto.randomUUID().slice(0, 8)}`;
  await db.prepare("UPDATE bookings SET deposit_status=?, deposit_paid_pence=?, stripe_payment_intent=? WHERE id=?").bind(deposit.status, deposit.paid ?? 0, deposit.status === "PAID" ? pi : "", booking.id).run();
  const shop = (await db.prepare("SELECT * FROM shops WHERE id=?").bind(s.shop_id).first<Shop>())!;
  const reload = async () => (await db.prepare("SELECT * FROM bookings WHERE id=?").bind(booking.id).first<StoredBooking & { deposit_refund_retry_at: number | null; stripe_refund_id: string }>())!;
  const setStatus = (st: string) => db.prepare("UPDATE bookings SET status=? WHERE id=?").bind(st, booking.id).run();
  return { s, shop, staffId: staff.id as string, booking, pi, reload, setStatus };
}
const refundCalls = () => fake.calls.filter((c) => c.path === "/v1/refunds");
const transferCalls = () => fake.calls.filter((c) => c.path === "/v1/transfers");

describe("deposit refunds", () => {
  it("refunds a paid deposit once and marks it REFUNDED", async () => {
    const w = await world();
    const before = refundCalls().length;
    expect(await refundDeposit(db, w.shop, await w.reload(), "test", "shop cancelled")).toBe(true);
    const b = await w.reload();
    expect(b.deposit_status).toBe("REFUNDED");
    expect(b.stripe_refund_id).toMatch(/^re_/);
    expect(refundCalls().length).toBe(before + 1);
    expect(refundCalls().at(-1)!.body.payment_intent).toBe(w.pi);
    // Asking again does nothing (it is no longer PAID) and sends nothing to Stripe.
    expect(await refundDeposit(db, w.shop, b, "test", "again")).toBe(false);
    expect(refundCalls().length).toBe(before + 1);
  });

  it("a refund Stripe refuses is flagged for retry, then goes through on the sweep", async () => {
    const w = await world();
    fake.failRefunds("api_connection_error");
    expect(await refundDeposit(db, w.shop, await w.reload(), "test", "shop cancelled")).toBe(false);
    let b = await w.reload();
    expect(b.deposit_status).toBe("PAID");
    expect(Number(b.deposit_refund_retry_at)).toBeGreaterThan(Date.now());
    const audit = await db.prepare("SELECT action FROM audit_events WHERE entity_id=? AND action='DEPOSIT_REFUND_FAILED'").bind(w.booking.id).all();
    expect(audit.results.length).toBe(1);
    // Not due yet: the sweep leaves it alone.
    expect(await retryDepositRefunds(db, Date.now())).toBe(0);
    fake.failRefunds(null);
    await retryDepositRefunds(db, Date.now() + 16 * 60000);
    b = await w.reload();
    expect(b.deposit_status).toBe("REFUNDED");
    expect(b.deposit_refund_retry_at).toBeNull();
  });

  it("'already refunded' at Stripe counts as done", async () => {
    const w = await world();
    fake.failRefunds("charge_already_refunded");
    expect(await refundDeposit(db, w.shop, await w.reload(), "test", "dashboard beat us")).toBe(true);
    fake.failRefunds(null);
    expect((await w.reload()).deposit_status).toBe("REFUNDED");
  });
});

describe("a payment arriving after the hold", () => {
  it("normal case: pending hold becomes PAID, and a duplicate event does nothing", async () => {
    const w = await world({ status: "PENDING" });
    expect(await markDepositPaid(db, w.shop.id, w.booking.id, 1000, "pi_normal_1", "cs_1")).toBe("paid");
    expect((await w.reload()).deposit_status).toBe("PAID");
    const before = refundCalls().length;
    expect(await markDepositPaid(db, w.shop.id, w.booking.id, 1000, "pi_normal_1", "cs_1")).toBeNull();
    expect(refundCalls().length).toBe(before);
  });

  it("hold lapsed but the slot is still free: the booking is restored, not refunded", async () => {
    const w = await world({ status: "EXPIRED" });
    await db.prepare("UPDATE bookings SET status='CANCELLED', deposit_hold_until=1 WHERE id=?").bind(w.booking.id).run();
    const before = refundCalls().length;
    expect(await markDepositPaid(db, w.shop.id, w.booking.id, 1000, "pi_late_free", "cs_2")).toBe("paid");
    const b = await w.reload();
    expect(b.status).toBe("CONFIRMED");
    expect(b.deposit_status).toBe("PAID");
    expect(refundCalls().length).toBe(before);
  });

  it("customer already cancelled: the money goes straight back and the booking stays cancelled", async () => {
    const w = await world({ status: "EXPIRED" });
    await db.prepare("UPDATE bookings SET status='CANCELLED', deposit_hold_until=NULL WHERE id=?").bind(w.booking.id).run();
    const before = refundCalls().length;
    expect(await markDepositPaid(db, w.shop.id, w.booking.id, 1000, "pi_late_cancelled", "cs_3")).toBe("refunded");
    const b = await w.reload();
    expect(b.status).toBe("CANCELLED");
    expect(b.deposit_status).toBe("REFUNDED");
    expect(refundCalls().length).toBe(before + 1);
    expect(refundCalls().at(-1)!.body.payment_intent).toBe("pi_late_cancelled");
  });

  it("slot taken by someone else meanwhile: refunded, never double-booked", async () => {
    const w = await world({ status: "EXPIRED" });
    await db.prepare("UPDATE bookings SET status='CANCELLED', deposit_hold_until=1 WHERE id=?").bind(w.booking.id).run();
    // Someone else now holds the very same slot: a copy of the booking, inserted the way the owner's
    // "book anyway" does it (force flag, inside one transaction).
    const cols = (await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_name='bookings' ORDER BY ordinal_position").all<{ column_name: string }>()).results.map((r) => r.column_name);
    const swap = (c: string) => (c === "id" ? "'taker-" + crypto.randomUUID() + "'" : c === "status" ? "'CONFIRMED'" : c === "request_id" ? "'" + crypto.randomUUID() + "'" : c === "request_hash" ? "'x'" : c === "sequence" ? "(SELECT COALESCE(MAX(sequence),0)+1 FROM bookings WHERE shop_id='" + w.shop.id + "')" : c === "deposit_status" ? "'NONE'" : c === "stripe_payment_intent" ? "''" : c === "stripe_session_id" ? "''" : c === "phone" ? "'07700900999'" : c);
    await db.batch([
      db.prepare("SELECT set_config('ollo.force_slot','1',true)"),
      db.prepare(`INSERT INTO bookings(${cols.join(",")}) SELECT ${cols.map(swap).join(",")} FROM bookings WHERE id=?`).bind(w.booking.id),
    ]);
    const taken = (await db.prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE shop_id=? AND date=? AND start_min=? AND status='CONFIRMED'").bind(w.shop.id, w.booking.date, w.booking.start_min).first<{ n: number }>())!.n;
    expect(taken).toBe(1); // the taker really is there, so the refund below is the slot-conflict path
    const before = refundCalls().length;
    expect(await markDepositPaid(db, w.shop.id, w.booking.id, 1000, "pi_late_taken", "cs_4")).toBe("refunded");
    const b = await w.reload();
    expect(b.status).toBe("CANCELLED");
    expect(b.deposit_status).toBe("REFUNDED");
    expect(refundCalls().length).toBe(before + 1);
  });
});

describe("kept deposits reach the ledger", () => {
  it("a deposit kept on a cancelled visit becomes one ONLINE ledger row with the platform fee", async () => {
    const w = await world();
    await w.setStatus("CANCELLED");
    const b = await w.reload();
    expect(await keepDepositInLedger(db, w.shop, b, "customer", "cancelled inside the policy window")).toBe(true);
    const rows = await db.prepare("SELECT method, service_pence, platform_fee_pence, stripe_payment_intent, voided_at FROM payments WHERE booking_id=?").bind(w.booking.id).all<any>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0]).toMatchObject({ method: "ONLINE", service_pence: 1000, platform_fee_pence: 15, stripe_payment_intent: w.pi });
    expect(rows.results[0].voided_at).toBeNull();
    // Idempotent.
    expect(await keepDepositInLedger(db, w.shop, b, "customer", "again")).toBe(false);
    expect((await db.prepare("SELECT COUNT(*)::int AS n FROM payments WHERE booking_id=?").bind(w.booking.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("a deposit that was refunded is not kept", async () => {
    const w = await world({ status: "REFUNDED", paid: 1000 });
    await w.setStatus("CANCELLED");
    expect(await keepDepositInLedger(db, w.shop, await w.reload(), "customer", "x")).toBe(false);
  });
});

// Pay run plumbing: a kept deposit in the ledger, a run row for it, and (optionally) payout accounts.
async function payRunWorld(accounts: { staff: boolean; shop: boolean }) {
  const w = await world();
  await w.setStatus("CANCELLED");
  await keepDepositInLedger(db, w.shop, await w.reload(), "customer", "policy");
  const pay = (await db.prepare("SELECT id, date FROM payments WHERE booking_id=?").bind(w.booking.id).first<{ id: string; date: string }>())!;
  const staff = (await db.prepare("SELECT * FROM staff WHERE id=?").bind(w.staffId).first<any>())!;
  const runId = crypto.randomUUID(), now = Date.now();
  await db.prepare(
    "INSERT INTO pay_runs(id,shop_id,staff_id,period_from,period_to,pay_model,terms_json,net_pence,status,created_by,created_at,updated_at,card_service_pence,transfer_pence,shop_transfer_pence,transfer_group) VALUES(?,?,?,?,?,'COMMISSION','{}',500,'APPROVED','test',?,?,1000,500,485,?)",
  ).bind(runId, w.shop.id, staff.id, pay.date, pay.date, now, now, `payrun_${runId}`).run();
  const addAcct = (type: string, owner: string) => db.prepare("INSERT INTO connected_accounts(id,shop_id,owner_type,owner_id,details_submitted,charges_enabled,payouts_enabled,created_at,updated_at) VALUES(?,?,?,?,1,1,1,?,?)").bind(`acct_${crypto.randomUUID().slice(0, 8)}`, w.shop.id, type, owner, now, now).run();
  if (accounts.staff) await addAcct("STAFF", staff.id);
  if (accounts.shop) await addAcct("SHOP", w.shop.id);
  const run = async () => (await db.prepare("SELECT * FROM pay_runs WHERE id=?").bind(runId).first<any>())!;
  return { ...w, pay, staff, runId, run, addAcct, now };
}

describe("pay runs", () => {
  it("a leg whose payout account is not ready leaves the run APPROVED and the payments unsettled, then sends once ready", async () => {
    const w = await payRunWorld({ staff: false, shop: true }); // barber has not finished Stripe setup
    const t0 = transferCalls().length;
    const r1 = await executeRun(db, w.shop, await w.run(), w.staff, "test", { force: true });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/Held/);
    const held = await w.run();
    expect(held.status).toBe("APPROVED");
    expect(held.transferred_at).toBeNull();
    expect((await db.prepare("SELECT pay_run_id FROM payments WHERE id=?").bind(w.pay.id).first<any>()).pay_run_id).toBeNull();
    expect(transferCalls().length).toBe(t0 + 1); // the shop leg went; the barber leg waits
    expect((await db.prepare("SELECT action FROM audit_events WHERE entity_id=? AND action='PAY_RUN_HELD'").bind(w.runId).all()).results.length).toBe(1);
    // Barber finishes setup. Retrying sends only the missing leg (shop leg is idempotent), then settles.
    await w.addAcct("STAFF", w.staff.id).catch(async () => {
      await db.prepare("UPDATE connected_accounts SET payouts_enabled=1, details_submitted=1 WHERE shop_id=? AND owner_type='STAFF' AND owner_id=?").bind(w.shop.id, w.staff.id).run();
    });
    const r2 = await executeRun(db, w.shop, await w.run(), w.staff, "test", { force: true });
    expect(r2.ok).toBe(true);
    const done = await w.run();
    expect(done.status).toBe("TRANSFERRED");
    expect((await db.prepare("SELECT pay_run_id FROM payments WHERE id=?").bind(w.pay.id).first<any>()).pay_run_id).toBe(w.runId);
    const legs = (await db.prepare("SELECT owner_type, amount_pence FROM transfers WHERE pay_run_id=? AND kind='PAYOUT' ORDER BY owner_type").bind(w.runId).all<any>()).results;
    expect(legs).toEqual([{ owner_type: "SHOP", amount_pence: 485 }, { owner_type: "STAFF", amount_pence: 500 }]);
  });

  it("refunding a deposit that a pay run already paid out voids the ledger row and reverses the transfers", async () => {
    const w = await payRunWorld({ staff: true, shop: true });
    expect((await executeRun(db, w.shop, await w.run(), w.staff, "test", { force: true })).ok).toBe(true);
    const rev0 = fake.calls.filter((c) => /reversals$/.test(c.path)).length;
    expect(await refundDeposit(db, w.shop, await w.reload(), "test", "goodwill")).toBe(true);
    const pay = await db.prepare("SELECT voided_at FROM payments WHERE id=?").bind(w.pay.id).first<any>();
    expect(pay.voided_at).not.toBeNull();
    expect(fake.calls.filter((c) => /reversals$/.test(c.path)).length).toBe(rev0 + 2);
    const back = (await db.prepare("SELECT SUM(amount_pence)::int AS s FROM transfers WHERE pay_run_id=? AND kind='REVERSAL'").bind(w.runId).first<any>()).s;
    expect(back).toBe(-985); // everything that went out comes back, nothing more
  });
});

describe("refunds made in the Stripe dashboard", () => {
  it("a full refund of a deposit closes the booking's deposit and voids the ledger row", async () => {
    const w = await world();
    await w.setStatus("CANCELLED");
    await keepDepositInLedger(db, w.shop, await w.reload(), "customer", "policy");
    await handleConnectEvent(db, { id: "evt_x", type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: w.pi, amount: 1000, amount_refunded: 1000, refunded: true } } });
    expect((await w.reload()).deposit_status).toBe("REFUNDED");
    expect((await db.prepare("SELECT voided_at FROM payments WHERE booking_id=?").bind(w.booking.id).first<any>()).voided_at).not.toBeNull();
  });
});
