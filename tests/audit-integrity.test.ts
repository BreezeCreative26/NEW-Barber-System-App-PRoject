import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { readFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import app from "../src/index";
import { toPositional, type Database, type Statement } from "../src/db/client";
import { enqueue, drain, msgShop } from "../src/server/messaging";
import { issueManualInvoice, issuePeriodInvoice, issueCreditNote, markPaid } from "../src/server/invoicing";
import { executeRun } from "../src/server/payouts";
import { settleRequest } from "../src/server/chair";
import { creditFee, effectiveFee, feeAmount, feeStatement, quoteFee, quotedFeeAmount, setFeeRule } from "../src/server/fees";
import { sameOrigin } from "../src/server/accounts";
import { routeByHost } from "../src/server/hosts";
import { openDelivery, publicShop, redactNotification, redactProviderCosts, sealDelivery, testAuthEnabled } from "../src/server/security";

// Real Postgres semantics in memory: no external database, provider or filesystem data directory.
function adapter(client: any, inTransaction = false): Database {
  let changes = 0;
  const db = {
    sql: client,
    prepare(sql: string): Statement {
      const make = (args: unknown[] = []): Statement => {
        const run = async () => {
          const q = toPositional(sql.replace(/\bchanges\(\)/g, String(changes)), args);
          const result = await client.query(q.text, q.values);
          changes = result.affectedRows ?? result.rows.length;
          return { results: result.rows, meta: { changes, last_row_id: 0, duration: 0 }, success: true as const };
        };
        return { sql, args, bind: (...args) => make(args), run, all: run, first: async (column?: string) => {
          const row = (await run()).results[0];
          return row ? column ? row[column] : row : null;
        } } as Statement;
      };
      return make();
    },
    async batch(statements: Statement[]) {
      return db.transaction(async (tx: Database) => {
        const out = [];
        for (const s of statements) out.push(await tx.prepare(s.sql).bind(...s.args).run());
        return out;
      });
    },
    transaction(fn: (tx: Database) => Promise<unknown>) {
      return inTransaction ? fn(db as Database) : client.transaction((tx: any) => fn(adapter(tx, true)));
    },
  };
  return db as Database;
}

const origin = "http://localhost";
let pg: PGlite, db: Database, ownerCookie = "", shopId = "", ownerId = "";
const slug = "audit-shop";
const A = `/api/public/shops/${slug}/account`;
const call = (path: string, method = "GET", body?: unknown, cookie = "") => app.request(origin + path, {
  method, headers: { origin, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
}, { DB: db });
const cookieOf = (r: Response, name: string) => r.headers.get("set-cookie")?.match(new RegExp(`${name}=[^;,]+`))?.[0] || "";
async function register(phone: string, email: string) {
  const code = await call(`${A}/register/start`, "POST", { phone });
  expect(code.status, await code.clone().text()).toBe(201);
  const { sandbox_code } = await code.json();
  const res = await call(`${A}/register`, "POST", { phone, email, code: sandbox_code, name: "Audit Customer", password: "Isolated-customer-password" });
  expect(res.status, await res.clone().text()).toBe(201);
  return cookieOf(res, "ollo_customer");
}
beforeAll(async () => {
  vi.stubEnv("DEMO_ENABLED", "1");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("SESSION_SECRET", "audit-only-delivery-secret-32-characters-long");
  for (const key of ["APP_ORIGIN", "APP_ROOT_HOST", "RESEND_API_KEY", "STRIPE_SECRET_KEY", "CLICKSEND_USERNAME", "CLICKSEND_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TELNYX_API_KEY"]) vi.stubEnv(key, "");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network disabled in audit tests"); }));
  pg = new PGlite({ extensions: { citext } });
  await pg.exec(readFileSync("src/db/schema.sql", "utf8"));
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(`src/db/migrations/${file}`, "utf8"));
  db = adapter(pg);
  const signup = await call("/api/app/auth/signup", "POST", { shop_name: "Audit Shop", slug, name: "Audit Owner", email: "owner@audit.test", password: "Isolated-owner-password", accept_legal: true });
  expect(signup.status, await signup.clone().text()).toBe(201);
  ownerCookie = cookieOf(signup, "ollo_session");
  const row = await db.prepare("SELECT id FROM shops WHERE slug=?").bind(slug).first<{ id: string }>();
  shopId = row!.id;
  ownerId = (await db.prepare("SELECT id FROM app_users WHERE email=?").bind("owner@audit.test").first<{ id: string }>())!.id;
  await db.prepare("UPDATE shops SET online_booking=1 WHERE id=?").bind(shopId).run();
}, 60000);
afterAll(async () => { await pg?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("audit security and database regressions", () => {
  it("requires phone proof, preserves registration, and never exposes codes in the staff outbox", async () => {
    const bad = await call(`${A}/register`, "POST", { phone: "07700900101", email: "customer@audit.test", name: "Imposter", password: "Isolated-customer-password" });
    expect(bad.status).toBe(400);
    const cookie = await register("07700900101", "customer@audit.test");
    expect(cookie).not.toBe("");
    const session = await call(`${A}/session`, "GET", undefined, cookie);
    expect((await session.json()).profile.account_email).toBe("customer@audit.test");
    const outbox = await call("/api/app/notifications", "GET", undefined, ownerCookie);
    expect(outbox.status).toBe(200);
    const messages = (await outbox.json()).notifications;
    expect(messages.filter((m: any) => m.template === "signin_code").every((m: any) => m.body === "Authentication message — content hidden")).toBe(true);
    const raw = await db.prepare("SELECT body FROM notifications WHERE template='signin_code' LIMIT 1").first<{ body: string }>();
    expect(raw!.body.startsWith("sealed:v1:")).toBe(true);
  });
  it("fails closed for provider-less recovery in production even when demo is enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(testAuthEnabled()).toBe(false);
      const r = await call(`${A}/forgot`, "POST", { email: "customer@audit.test" });
      expect(r.status).toBe(503);
      expect(await r.text()).not.toContain("sandbox_token");
    } finally { vi.stubEnv("NODE_ENV", "test"); }
  });
  it("consumes customer reset tokens once and deletes dependent data with the account", async () => {
    const recovery = await call(`${A}/forgot`, "POST", { email: "customer@audit.test" });
    expect(recovery.status).toBe(201);
    const { sandbox_token } = await recovery.json();
    const payload = { token: sandbox_token, password: "Replacement-password-123" };
    const reset = await call(`${A}/reset`, "POST", payload);
    expect(reset.status, await reset.clone().text()).toBe(201);
    expect((await call(`${A}/reset`, "POST", payload)).status).toBe(409);
    const cookie = cookieOf(reset, "ollo_customer");
    expect((await call(`${A}/delete`, "POST", { confirm: "DELETE" }, cookie)).status).toBe(200);
    expect(await db.prepare("SELECT 1 FROM customer_accounts WHERE email=?").bind("customer@audit.test").first()).toBeNull();
  });
  it("does not bootstrap a platform administrator from an email allowlist", async () => {
    vi.stubEnv("FOLIYO_ADMIN_EMAILS", "owner@audit.test");
    expect((await call("/api/admin/me", "GET", undefined, ownerCookie)).status).toBe(404);
    expect(Number((await db.prepare("SELECT count(*) AS n FROM platform_admins").first<any>())!.n)).toBe(0);
  });
  it("rejects sibling origins and untrusted internal host headers", async () => {
    expect(sameOrigin({ req: { url: origin, header: key => ({ origin: "http://sibling.localhost", "sec-fetch-site": "same-site" })[key] }, env: {} })).toBe(false);
    const r = await routeByHost(new Request(origin + "/workspace", { headers: { "x-foliyo-shop-host": "forged" } }), async () => false);
    expect(r.headers.get("x-foliyo-shop-host")).toBeNull();
    const csrf = await app.request(origin + "/api/admin/alerts/ack-all", { method: "POST", headers: { origin: "https://other.test", cookie: ownerCookie }, body: "{}" }, { DB: db });
    expect(csrf.status).toBe(403);
  });
  it("encrypts/authenticates auth payloads and strips integration secrets from shop views", () => {
    const encrypted = sealDelivery("one-time-secret");
    expect(encrypted).not.toContain("one-time-secret");
    expect(openDelivery(encrypted)).toBe("one-time-secret");
    expect(() => openDelivery(encrypted.slice(0, -5) + "AAAAA")).toThrow();
    expect(redactNotification({ template: "password_reset", body: "legacy-secret", html: "legacy-secret" }).body).not.toContain("legacy-secret");
    expect(publicShop({ voice_json: JSON.stringify({ enabled: true, secret: "credential", webhook_secret: "other" }) }).voice_json).not.toContain("credential");
  });
  it("rolls back webhook receipts when processing fails so Stripe can retry", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "audit-signature-secret");
    const raw = JSON.stringify({ id: "evt_audit", type: "checkout.session.completed", data: { object: { id: "cs_audit", setup_intent: "si_audit", metadata: { purpose: "billing_card", shop_id: shopId } } } });
    const t = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", "audit-signature-secret").update(`${t}.${raw}`).digest("hex");
    const send = () => app.request(origin + "/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${signature}` }, body: raw }, { DB: db });
    expect((await send()).status).toBe(500);
    expect(await db.prepare("SELECT id FROM stripe_events WHERE id='evt_audit'").first()).toBeNull();
    expect((await send()).status).toBe(500); // retried, not incorrectly acknowledged as duplicate
  });
  it("rolls back the PAID claim when settlement cannot complete", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec("CREATE TABLE payment_requests(id text PRIMARY KEY,status text,paid_at bigint,stripe_payment_intent text); INSERT INTO payment_requests VALUES('r','OPEN',NULL,'')");
      await expect(settleRequest(adapter(isolated), { id: "r", shop_id: "missing", booking_id: "missing", staff_id: "missing" } as any, "pi_audit", "stripe")).rejects.toThrow();
      expect((await isolated.query<any>("SELECT status FROM payment_requests")).rows[0].status).toBe("OPEN");
    } finally { await isolated.close(); }
  });
  it("keeps a pay run pending when recipients cannot receive transfers", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_not_a_real_key");
    try {
      const result = await executeRun(db, { id: shopId, name: "Audit Shop" } as any, { id: "run", status: "APPROVED", transfer_pence: 5000, shop_transfer_pence: 5000 } as any, { id: "staff", name: "Staff" } as any, "audit", { force: true });
      expect(result.ok).toBe(false);
      expect(result.skipped).toHaveLength(2);
      expect(result.transferred).toHaveLength(0);
    } finally { vi.stubEnv("STRIPE_SECRET_KEY", ""); }
  });
  it("claims a message once when two drainers race", async () => {
    const ms = await msgShop({ env: { DB: db } }, shopId);
    await db.batch(enqueue(db, ms, { email: "delivery@audit.test" }, "test_message", {}, { origin, related: { type: "audit", id: "one-message" }, channel: "EMAIL" }));
    const runs = await Promise.all([drain(db, 1, Date.now(), { type: "audit", id: "one-message" }), drain(db, 1, Date.now(), { type: "audit", id: "one-message" })]);
    expect(runs.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect((await db.prepare("SELECT attempts FROM notifications WHERE related_id='one-message'").first<any>())!.attempts).toBe(1);
  });
  it("enforces original invoice credit limits, including concurrent credits", async () => {
    const invoice = await issueManualInvoice(db, shopId, [{ label: "Service", amount_pence: 10000 }], "audit");
    await markPaid(db, invoice.id, 10000, "test", "", "audit");
    await issueCreditNote(db, invoice.id, 2000, "First credit", "audit");
    await expect(issueCreditNote(db, invoice.id, 9000, "Too much", "audit")).rejects.toThrow("Credit must be");
    const results = await Promise.allSettled([issueCreditNote(db, invoice.id, 5000, "Credit A", "audit"), issueCreditNote(db, invoice.id, 5000, "Credit B", "audit")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("allows aged terminal notification retention but protects recent and queued rows", async () => {
    const now = Date.now(), old = now - 181 * 86400000;
    for (const [id, status, at] of [["old", "SENT", old], ["recent", "SENT", now], ["queued", "QUEUED", old]] as const) {
      await db.prepare("INSERT INTO notifications(id,shop_id,channel,recipient,template,body,status,related_type,related_id,created_at) VALUES(?,?,'EMAIL','test@audit.test','test_message','text',?,'audit',?,?)").bind(id, shopId, status, id, at).run();
    }
    await expect(db.prepare("DELETE FROM notifications WHERE id='old'").run()).resolves.toBeDefined();
    await expect(db.prepare("DELETE FROM notifications WHERE id='recent'").run()).rejects.toThrow("notification_immutable");
    await expect(db.prepare("DELETE FROM notifications WHERE id='queued'").run()).rejects.toThrow("notification_immutable");
  });
});


async function feeBooking() {
  const bid = crypto.randomUUID(), staff = crypto.randomUUID(), service = crypto.randomUUID();
  const sh = (await db.prepare("SELECT * FROM shops WHERE id=?").bind(shopId).first<any>())!;
  await db.transaction(async tx => {
    await tx.prepare("SELECT set_config('ollo.force_slot','1',true)").first();
    await tx.prepare("INSERT INTO staff(id,shop_id,name) VALUES(?,?,'Fee Barber')").bind(staff, shopId).run();
    await tx.prepare("INSERT INTO services(id,shop_id,name,duration_min,price_pence) VALUES(?,?,'Fee Haircut',30,3000)").bind(service, shopId).run();
    const sequence = (await tx.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM bookings WHERE shop_id=?").bind(shopId).first<any>())!.n;
    const start = Date.parse("2030-01-07T12:00:00Z"), now = Date.now();
    const items = JSON.stringify([{ kind: "SERVICE", id: service, name: "Fee Haircut", price_pence: 3000, duration_min: 30 }]);
    await tx.prepare(`INSERT INTO bookings(id,shop_id,sequence,request_id,request_hash,staff_id,service_id,customer_name,phone,date,start_min,start_at,end_at,duration_min,service_name,price_pence,deposit_policy_pence,cancel_hours_snapshot,source,status,created_at,updated_at,quoted_service_version,quoted_shop_version,items_json)
      VALUES(?,?,?,?,?,?,?,'Fee Customer','','2030-01-07',720,?,?,30,'Fee Haircut',3000,?,?,'WALK_IN','IN_SERVICE',?,?,0,?,?)`)
      .bind(bid, shopId, sequence, bid, bid, staff, service, start, start + 1800000, Math.min(sh.deposit_pence, 3000), sh.cancel_hours, now, now, sh.version, items).run();
  });
  return { bid, staff, service };
}

describe("Foliyo fee controls", () => {
  beforeAll(async () => {
    await db.prepare("UPDATE app_users SET email_verified_at=? WHERE id=?").bind(Date.now(), ownerId).run();
    await db.prepare("INSERT INTO platform_admins(user_id,role,created_by,created_at) VALUES(?,'SUPER',?,?)").bind(ownerId, ownerId, Date.now()).run();
  });
  it("bounds and rounds advertised fees and removes supplier costs recursively", () => {
    expect(feeAmount(3000, { fee_bps: 150, fixed_pence: 20 })).toBe(65);
    expect(feeAmount(1, { fee_bps: 2000, fixed_pence: 500 })).toBe(1);
    expect(feeAmount(0, { fee_bps: 150, fixed_pence: 20 })).toBe(0);
    expect(feeAmount(3000, { fee_bps: 0, fixed_pence: 0 })).toBe(0);
    expect(redactProviderCosts({ payments: [{ platform_fee_pence: 65, stripe_fee_pence: 31 }], split: { margin_pence: 34 } })).toEqual({ payments: [{ platform_fee_pence: 65 }], split: {} });
  });
  it("restricts pricing to finance/super admins and requires notice confirmation and reason", async () => {
    const get = await call("/api/admin/fees", "GET", undefined, ownerCookie);
    expect(get.status, await get.clone().text()).toBe(200);
    const { defaults } = await get.json();
    const input = { version: defaults.version, fee_bps: 175, fixed_pence: 0, reason: "Agreed standard tariff", notice_confirmed: true };
    expect((await call("/api/admin/fees/default", "PUT", { ...input, notice_confirmed: false }, ownerCookie)).status).toBe(400);
    expect((await call("/api/admin/fees/default", "PUT", { ...input, reason: "" }, ownerCookie)).status).toBe(400);
    await db.prepare("UPDATE platform_admins SET role='SUPPORT' WHERE user_id=?").bind(ownerId).run();
    expect((await call("/api/admin/fees/default", "PUT", input, ownerCookie)).status).toBe(403);
    await db.prepare("UPDATE platform_admins SET role='SUPER' WHERE user_id=?").bind(ownerId).run();
    expect((await call("/api/app/fees/default", "PUT", input, ownerCookie)).status).toBe(403);
    const saved = await call("/api/admin/fees/default", "PUT", input, ownerCookie);
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect((await call("/api/admin/fees/default", "PUT", input, ownerCookie)).status).toBe(409);
    expect(await db.prepare("SELECT id FROM admin_audit WHERE action='FEE_RULE_CHANGED' LIMIT 1").first()).not.toBeNull();
  });
  it("keeps existing quotes fixed while overrides, waivers and defaults change", async () => {
    const source = crypto.randomUUID();
    const old = await quoteFee(db, shopId, "CHAIR", source);
    await setFeeRule(db, ownerId, shopId, { version: 0, fee_bps: 0, fixed_pence: 0, use_default: false, reason: "Agreed introductory waiver" });
    expect((await effectiveFee(db, shopId)).fee_bps).toBe(0);
    expect(await quotedFeeAmount(db, shopId, "CHAIR", source, 3000)).toBe(feeAmount(3000, old));
    expect((await quoteFee(db, shopId, "CHAIR", crypto.randomUUID())).fee_bps).toBe(0);
    await expect(db.prepare("UPDATE foliyo_fee_quotes SET fee_bps=1000 WHERE source_id=?").bind(source).run()).rejects.toThrow("wallet_history_immutable");
    const r = await call("/api/app/shop/payments", "GET", undefined, ownerCookie);
    expect((await r.json()).platform.fee_bps).toBe(0);
    const overview = await call("/api/admin/fees", "GET", undefined, ownerCookie);
    const defaults = (await overview.json()).defaults;
    expect((await call("/api/admin/fees/default", "PUT", { version: defaults.version, fee_bps: 200, fixed_pence: 0, notice_confirmed: true, reason: "New agreement for all shops", reset_overrides: true }, ownerCookie)).status).toBe(400);
    const all = await call("/api/admin/fees/default", "PUT", { version: defaults.version, fee_bps: 200, fixed_pence: 0, notice_confirmed: true, reason: "New agreement for all shops", reset_overrides: true, confirm_all: "ALL SHOPS" }, ownerCookie);
    expect(all.status).toBe(200);
    expect((await effectiveFee(db, shopId)).fee_bps).toBe(200);
    expect(await db.prepare("SELECT id FROM admin_audit WHERE action='FEE_OVERRIDE_RESET' AND shop_id=?").bind(shopId).first()).not.toBeNull();
  });
  it("records deposit fees once and never reprices them when posting the ledger later", async () => {
    const { bid, staff } = await feeBooking();
    const now = Date.now();
    // A fixed ledger period avoids UTC/shop-midnight drift in this fee snapshot test.
    const paymentDate = "2030-01-07";
    await db.prepare("UPDATE bookings SET deposit_status='PAID',deposit_paid_pence=3000,stripe_payment_intent='pi_fee_deposit',updated_at=? WHERE id=?").bind(now, bid).run();
    const receipt = await db.prepare("SELECT fee_pence FROM wallet_receipts WHERE payment_intent='pi_fee_deposit'").first<any>();
    expect(receipt!.fee_pence).toBe(60);
    const rule = await db.prepare("SELECT version FROM foliyo_fee_rules WHERE scope='default'").first<any>();
    await setFeeRule(db, ownerId, "default", { version: rule!.version, fee_bps: 500, fixed_pence: 0, use_default: false, reason: "New rates for future payments" });
    const originalFee = await quotedFeeAmount(db, shopId, "BOOKING", bid, 3000);
    expect(originalFee).toBe(60);
    await db.prepare(`INSERT INTO payments(id,shop_id,booking_id,staff_id,date,method,service_pence,tip_pence,discount_pence,commission_pct,recorded_by,created_at,stripe_payment_intent,platform_fee_pence,stripe_fee_pence)
      VALUES(?,?,?,?,?,'ONLINE',3000,0,0,50,'stripe',?,'pi_fee_deposit',?,99)`)
      .bind(crypto.randomUUID(), shopId, bid, staff, paymentDate, now, originalFee).run();
    expect(Number((await db.prepare("SELECT COUNT(*) AS n FROM foliyo_fee_charges WHERE payment_intent='pi_fee_deposit'").first<any>())!.n)).toBe(1);
    const payments = await call(`/api/app/wallet?from=${paymentDate}&to=${paymentDate}`, "GET", undefined, ownerCookie);
    expect(payments.status).toBe(200);
    const wallet = await payments.json();
    expect(wallet.from).toBe(paymentDate);
    expect(wallet.to).toBe(paymentDate);
    expect(wallet.payments.find((p: any) => p.stripe_payment_intent === "pi_fee_deposit").platform_fee_pence).toBe(60);
    expect(JSON.stringify(wallet)).not.toContain("stripe_fee_pence");
  });
  it("credits a fee once, caps concurrent credits and keeps internal reasons out of billing", async () => {
    const first = { request_id: crypto.randomUUID(), payment_intent: "pi_fee_deposit", amount_pence: 20, reason: "Private commercial margin adjustment" };
    const a = await creditFee(db, ownerId, shopId, first);
    const b = await creditFee(db, ownerId, shopId, first);
    expect(b.replay).toBe(true); expect(a.adjustment_id).toBe(b.adjustment_id);
    await expect(creditFee(db, ownerId, shopId, { ...first, amount_pence: 21 })).rejects.toThrow("different details");
    const races = await Promise.allSettled([1, 2].map(() => creditFee(db, ownerId, shopId, { ...first, request_id: crypto.randomUUID(), amount_pence: 30 })));
    expect(races.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const adj = (await db.prepare("SELECT reason FROM invoice_adjustments WHERE id=?").bind(a.adjustment_id).first<any>())!;
    expect(adj.reason).toContain("Foliyo fee correction"); expect(adj.reason).not.toContain("margin");
    const today = new Date().toISOString().slice(0, 10);
    const statement = await feeStatement(db, shopId, today, today);
    expect(statement.totals.fee_pence).toBe(60); expect(statement.totals.credited_pence).toBe(50);
    const csv = await call(`/api/app/shop/fees/statement.csv?from=${today}&to=${today}`, "GET", undefined, ownerCookie);
    expect(csv.status).toBe(200); expect(await csv.text()).not.toMatch(/stripe_fee|margin|Private commercial/);
  });
  it("shows deducted fees on the period invoice without charging them twice", async () => {
    const period = new Date().toISOString().slice(0, 7);
    const results = await Promise.all([issuePeriodInvoice(db, shopId, period, "audit", { force: true }), issuePeriodInvoice(db, shopId, period, "audit", { force: true })]);
    expect(results.filter(r => "skipped" in r && r.skipped === "already issued")).toHaveLength(1);
    const invoice = (results[0] as any).invoice;
    const feeLine = JSON.parse(invoice.lines_json).find((l: any) => l.label === "Foliyo payment fees (already deducted)");
    expect(feeLine.amount_pence).toBe(0); expect(feeLine.detail).toContain("GBP 0.60");
    expect(invoice.credit_applied_pence).toBeGreaterThanOrEqual(50);
    expect(invoice.lines_json).not.toMatch(/stripe_fee|margin/);
  });
});


describe("fee tenant isolation", () => {
  it("does not let another shop view fee charges or use finance controls", async () => {
    const response = await call("/api/app/auth/signup", "POST", { shop_name: "Other Fee Shop", slug: "other-fee-shop", name: "Other Owner", email: "other-fees@audit.test", password: "Isolated-other-password", accept_legal: true });
    expect(response.status, await response.clone().text()).toBe(201);
    const cookie = cookieOf(response, "ollo_session");
    const own = await call(`/api/app/shop/fees/statement?shop_id=${shopId}`, "GET", undefined, cookie);
    expect(own.status).toBe(200);
    expect((await own.json()).totals.count).toBe(0);
    expect((await call(`/api/admin/fees/${shopId}/statement`, "GET", undefined, cookie)).status).toBe(404);
    expect((await call(`/api/admin/fees/${shopId}/credits`, "POST", { request_id: crypto.randomUUID(), payment_intent: "pi_fee_deposit", amount_pence: 1, reason: "Unauthorised credit" }, cookie)).status).toBe(404);
    const other = await db.prepare("SELECT id FROM shops WHERE slug='other-fee-shop'").first<any>();
    await expect(creditFee(db, ownerId, other!.id, { request_id: crypto.randomUUID(), payment_intent: "pi_fee_deposit", amount_pence: 1, reason: "Wrong shop identity" })).rejects.toThrow("Fee charge not found");
  });
  it("requests only the connected shop balance, never the shared platform balance", async () => {
    await db.prepare("INSERT INTO connected_accounts(id,shop_id,owner_type,owner_id,created_at,updated_at) VALUES('acct_fee_shop',?,'SHOP',?,0,0)").bind(shopId, shopId).run();
    const original = globalThis.fetch;
    const mock = vi.fn(async (_url: any, init: any) => {
      expect(new Headers(init.headers).get("Stripe-Account")).toBe("acct_fee_shop");
      return Response.json({ available: [{ currency: "gbp", amount: 123 }], pending: [] });
    });
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_isolated"); vi.stubGlobal("fetch", mock);
    try {
      const r = await call("/api/app/payments/balance", "GET", undefined, ownerCookie);
      expect(r.status).toBe(200); expect((await r.json()).available_pence).toBe(123);
      expect(mock).toHaveBeenCalledTimes(1);
    } finally { vi.stubEnv("STRIPE_SECRET_KEY", ""); vi.stubGlobal("fetch", original); }
  });
});


describe("waiting-list functionality and customer search", () => {
  const barber = crypto.randomUUID(), service = crypto.randomUUID();
  const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  let nextPhone = 700;
  const auth = (path: string, method = "GET", body?: unknown) => call(`/api/app${path}`, method, body, ownerCookie);
  async function entry(from = day(2), to = from) {
    const id = crypto.randomUUID(), now = Date.now();
    await db.prepare("INSERT INTO waitlist_entries(id,shop_id,staff_id,service_id,customer_name,phone,date,date_to,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(id, shopId, barber, service, "Waiting Customer", `07700900${nextPhone++}`, from, to, now, now).run();
    return id;
  }
  const offer = (id: string, minute: number, version = 0) => auth(`/waitlist/${id}/offer`, "POST", { staff_id: barber, start_min: minute, version });
  beforeAll(async () => {
    await db.prepare("INSERT INTO staff(id,shop_id,name) VALUES(?,?,'Queue Barber')").bind(barber, shopId).run();
    await db.prepare("INSERT INTO services(id,shop_id,name,duration_min,price_pence) VALUES(?,?,'Queue Cut',30,2500)").bind(service, shopId).run();
    for (let weekday = 0; weekday < 7; weekday++) await db.prepare("INSERT INTO staff_hours(shop_id,staff_id,weekday,enabled,starts,ends,break_start,break_end) VALUES(?,?,?,1,540,1080,540,540)").bind(shopId, barber, weekday).run();
    await db.prepare("UPDATE shops SET waitlist_enabled=1,waitlist_auto_offer=0,lead_time_min=0,opens=540,closes=1080,closed_days='[]',week_json=?,deposit_pence=0,payment_mode='PAY_AT_VISIT',version=version+1 WHERE id=?")
      .bind(JSON.stringify(Array.from({ length: 7 }, () => ({ enabled: 1, starts: 540, ends: 1080 }))), shopId).run();
  });
  it("keeps multi-day requests active until their last day and includes them in counts", async () => {
    const id = await entry(day(-2), day(3));
    const expired = await entry(day(-3), day(-1));
    const r = await auth(`/waitlist?from=${day(0)}`);
    expect(r.status, await r.clone().text()).toBe(200);
    const data = await r.json();
    expect(data.waitlist.some((e: any) => e.id === id)).toBe(true);
    expect(data.waitlist.some((e: any) => e.id === expired)).toBe(false);
    expect(Number(data.counts.OPEN)).toBeGreaterThan(0);
    expect((await db.prepare("SELECT status FROM waitlist_entries WHERE id=?").bind(expired).first<any>())!.status).toBe("EXPIRED");
    const matches = await auth(`/waitlist/${id}/matches`);
    expect((await matches.json()).matches.some((m: any) => m.date === day(3))).toBe(true);
  });
  it("excludes blocked time and trailing booking buffers from offered matches", async () => {
    const id = await entry(), block = crypto.randomUUID();
    await db.prepare("INSERT INTO staff_blocks(id,shop_id,staff_id,date,start_min,end_min,created_by,created_at) VALUES(?,?,?,?,600,660,'test',?)").bind(block, shopId, barber, day(2), Date.now()).run();
    const r = await auth(`/waitlist/${id}/matches`);
    expect(r.status, await r.clone().text()).toBe(200);
    const { matches } = await r.json();
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m: any) => m.start_min >= 570 && m.start_min < 660)).toBe(false);
    expect((await offer(id, 600)).status).toBe(409);
    await db.prepare("DELETE FROM staff_blocks WHERE id=?").bind(block).run();
  });
  it("creates one offer for duplicate submissions and rejects overlapping offers", async () => {
    const id = await entry();
    const results = await Promise.all([offer(id, 600), offer(id, 600)]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(Number((await db.prepare("SELECT COUNT(*) AS n FROM waitlist_offers WHERE entry_id=?").bind(id).first<any>())!.n)).toBe(1);
    const another = await entry();
    expect((await offer(another, 615)).status).toBe(409);
    const success = await results.find(r => r.status === 201)!.json();
    const token = new URL(success.offer.link).pathname.split("/").pop();
    expect((await auth(`/waitlist/${id}/status`, "POST", { status: "BOOKED", version: 1 })).status).toBe(400);
    expect((await auth(`/waitlist/${id}/status`, "POST", { status: "CLOSED", version: 1 })).status).toBe(200);
    expect((await call(`/api/public/offer/${token}/accept`, "POST", {})).status).toBe(409);
  });
  it("accepts an offer once, replays safely, and links the waiting customer", async () => {
    const id = await entry();
    const r = await offer(id, 720);
    expect(r.status, await r.clone().text()).toBe(201);
    const token = new URL((await r.json()).offer.link).pathname.split("/").pop();
    const accepted = await call(`/api/public/offer/${token}/accept`, "POST", {});
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    const first = await accepted.json();
    const again = await call(`/api/public/offer/${token}/accept`, "POST", {});
    expect(again.status, await again.clone().text()).toBe(200);
    expect((await again.json()).booking.id).toBe(first.booking.id);
    const row = await db.prepare("SELECT status,booking_id FROM waitlist_entries WHERE id=?").bind(id).first<any>();
    expect(row).toMatchObject({ status: "BOOKED", booking_id: first.booking.id });
  });
  it("declines and expires offers without removing an active date-range request", async () => {
    const id = await entry();
    const r = await offer(id, 840);
    expect(r.status).toBe(201);
    const token = new URL((await r.json()).offer.link).pathname.split("/").pop();
    expect((await call(`/api/public/offer/${token}/decline`, "POST", {})).status).toBe(200);
    expect((await db.prepare("SELECT status FROM waitlist_entries WHERE id=?").bind(id).first<any>())!.status).toBe("OPEN");
    const expiredId = await entry();
    expect((await offer(expiredId, 900)).status).toBe(201);
    await db.prepare("UPDATE waitlist_offers SET expires_at=? WHERE entry_id=?").bind(Date.now() - 1, expiredId).run();
    await auth("/waitlist");
    expect((await db.prepare("SELECT status,offer_id FROM waitlist_entries WHERE id=?").bind(expiredId).first<any>())!).toMatchObject({ status: "OPEN", offer_id: null });
  });
  it("updates a public waiting request and invalidates its previous offer", async () => {
    const phone = "07700900901";
    const body = { staff_id: barber, service_id: service, customer_name: "Repeat Join", phone, email: "", date: day(4), daypart: "ANY", notes: "" };
    const join = () => call(`/api/public/shops/${slug}/waitlist`, "POST", body);
    expect((await join()).status).toBe(201);
    const row = await db.prepare("SELECT id FROM waitlist_entries WHERE shop_id=? AND phone=?").bind(shopId, phone).first<any>();
    const sent = await offer(row!.id, 600);
    expect(sent.status,await sent.clone().text()).toBe(201);
    const token = new URL((await sent.json()).offer.link).pathname.split("/").pop();
    expect((await join()).status).toBe(201);
    expect((await db.prepare("SELECT status,offer_id FROM waitlist_entries WHERE id=?").bind(row!.id).first<any>())!).toMatchObject({ status: "OPEN", offer_id: null });
    expect((await call(`/api/public/offer/${token}/accept`, "POST", {})).status).toBe(409);
  });
  it("shows the barber's actual price and duration in an offer", async () => {
    await db.prepare("INSERT INTO staff_service_rules(shop_id,staff_id,service_id,enabled,price_pence,duration_min) VALUES(?,?,?,1,3100,45)").bind(shopId,barber,service).run();
    const id = await entry(day(5));
    const r = await offer(id,600);
    expect(r.status,await r.clone().text()).toBe(201);
    const token = new URL((await r.json()).offer.link).pathname.split("/").pop();
    const view = await call(`/api/public/offer/${token}`);
    expect((await view.json()).offer).toMatchObject({ price_pence: 3100, duration_min: 45 });
    await db.prepare("DELETE FROM staff_service_rules WHERE shop_id=? AND staff_id=? AND service_id=?").bind(shopId,barber,service).run();
  });
  it("does not notify parked slots after automatic offers are disabled", async () => {
    await entry();
    await db.prepare("INSERT INTO waitlist_pending_slots(shop_id,staff_id,date,start_min,why,freed_at,notify_at) VALUES(?,?,?,960,'test',?,?)").bind(shopId, barber, day(2), Date.now()-10000, Date.now()-1).run();
    const before = Number((await db.prepare("SELECT COUNT(*) AS n FROM waitlist_offers WHERE shop_id=?").bind(shopId).first<any>())!.n);
    await auth("/waitlist");
    expect(Number((await db.prepare("SELECT COUNT(*) AS n FROM waitlist_offers WHERE shop_id=?").bind(shopId).first<any>())!.n)).toBe(before);
  });
  it("searches customer words and formatted phones, treating wildcard characters literally", async () => {
    for (const [name, phone] of [["Search Ada Customer", "07700900801"], ["Search 100% Customer", "07700900802"]]) {
      await db.prepare("INSERT INTO customers(id,shop_id,name,phone,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(),shopId,name,phone,Date.now(),Date.now()).run();
    }
    for (const term of ["Ada Search", "+44 7700 900801"]) {
      const r = await auth(`/customers?q=${encodeURIComponent(term)}`);
      expect(r.status,await r.clone().text()).toBe(200);
      expect((await r.json()).customers.map((c: any) => c.name)).toEqual(["Search Ada Customer"]);
    }
    const r = await auth("/customers?q=%25");
    expect((await r.json()).customers.map((c: any) => c.name)).toEqual(["Search 100% Customer"]);
  });
  it("rejects missing, duplicate and stale schedule decisions before saving a closure", async () => {
    const change = { kind: "holiday", change: { date: day(2), label: "Audit closure" } };
    const preview = await auth("/schedule/preview", "POST", change);
    expect(preview.status,await preview.clone().text()).toBe(200);
    const conflicts = (await preview.json()).conflicts;
    expect(conflicts.length).toBeGreaterThan(0);
    const decisions = conflicts.map((b: any) => ({ booking_id: b.booking_id, version: b.version, action: "KEEP", notify: false }));
    for (const plan of [[], [...decisions, decisions[0]], decisions.map((d: any) => ({ ...d, version: d.version + 1 }))]) {
      const r = await auth("/schedule/apply", "POST", { change, decisions: plan });
      expect([400,409]).toContain(r.status);
      expect(await db.prepare("SELECT id FROM holidays WHERE shop_id=? AND date=?").bind(shopId, day(2)).first()).toBeNull();
    }
    const saved = await auth("/schedule/apply", "POST", { change, decisions });
    expect(saved.status,await saved.clone().text()).toBe(201);
    const data = await saved.json();
    expect(data.outcome.every((o: any) => o.ok)).toBe(true);
    expect(await db.prepare("SELECT id FROM holidays WHERE shop_id=? AND date=?").bind(shopId, day(2)).first()).not.toBeNull();
  });

});

describe("shop signup and setup audit", () => {
  let cookie = "", id = "", user = "", uploadedLogo = "";
  const owner = (path: string, method = "GET", body?: unknown) => call(`/api/app${path}`, method, body, cookie);
  const contact = { name: "Setup Audit", kind: "BARBER", phone: "07700900888", email: "shop@setup.test", address: "12 Test Street", timezone: "Europe/London", currency: "GBP" };
  it("creates an owner, shop, session, legal acceptances and a real default roster without fake services", async () => {
    const r = await call("/api/app/auth/signup", "POST", { shop_name: "Setup Audit", name: "Setup Owner", email: "owner@setup.test", password: "Setup-password-123", accept_legal: true });
    expect(r.status, await r.clone().text()).toBe(201);
    cookie = cookieOf(r, "ollo_session"); id = (await r.json()).shop_id;
    expect(cookie).not.toBe("");
    const w = await (await owner("/workspace")).json();
    user = w.account.user_id;
    expect(w.account).toMatchObject({ role: "OWNER", staff_id: null });
    expect(w.shop).toMatchObject({ name: "Setup Audit", timezone: "Europe/London", email: "owner@setup.test", online_booking: 0, slug: null });
    expect(w.staff).toHaveLength(1); expect(w.staff[0].name).toBe("Setup Owner");
    expect(w.services).toEqual([]); expect(w.hours).toHaveLength(7);
    expect(w.hours.filter((h: any) => h.enabled).map((h: any) => h.weekday).sort()).toEqual([1,2,3,4,5,6]);
    expect(w.hours.every((h: any) => h.starts === 540 && h.ends === 1080)).toBe(true);
    expect(await db.prepare("SELECT 1 FROM shop_owners WHERE shop_id=? AND user_id=?").bind(id,user).first()).not.toBeNull();
    expect(Number((await db.prepare("SELECT count(*) AS n FROM legal_acceptances WHERE user_id=?").bind(user).first<any>())!.n)).toBeGreaterThan(0);
    const duplicate = await call("/api/app/auth/signup", "POST", { shop_name: "Duplicate", name: "Owner", email: "owner@setup.test", password: "Setup-password-123", accept_legal: true });
    expect(duplicate.status).toBe(409);
  });
  it("rejects invalid details and preserves business identity on contact-only saves", async () => {
    await db.prepare("UPDATE shops SET legal_name='Legal Ltd', vat_number='VAT123', company_number='CO123', website='https://example.test' WHERE id=?").bind(id).run();
    expect((await owner("/setup/contact", "PUT", { ...contact, timezone: "Invalid/Zone" })).status).toBe(400);
    expect((await owner("/setup/contact", "PUT", { ...contact, email: "not-an-email" })).status).toBe(400);
    const r = await owner("/setup/contact", "PUT", contact);
    expect(r.status,await r.clone().text()).toBe(200);
    expect((await r.json()).shop).toMatchObject({ phone: "+447700900888", legal_name: "Legal Ltd", vat_number: "VAT123", company_number: "CO123", website: "https://example.test" });
  });
  it("invalidates old contact codes, counts wrong attempts and consumes valid codes once", async () => {
    const first = await owner("/setup/verify/start", "POST", { kind: "PHONE" });
    expect(first.status,await first.clone().text()).toBe(201);
    const oldCode = (await first.json()).sandbox_code;
    await owner("/setup/contact", "PUT", { ...contact, phone: "07700900889" });
    expect((await owner("/setup/verify/confirm", "POST", { kind: "PHONE", code: oldCode })).status).toBe(409);
    const next = await (await owner("/setup/verify/start", "POST", { kind: "PHONE" })).json();
    const wrong = next.sandbox_code === "000000" ? "111111" : "000000";
    expect((await owner("/setup/verify/confirm", "POST", { kind: "PHONE", code: wrong })).status).toBe(401);
    expect((await db.prepare("SELECT attempts FROM contact_codes WHERE shop_id=? AND kind='PHONE'").bind(id).first<any>())!.attempts).toBe(1);
    const confirm = await owner("/setup/verify/confirm", "POST", { kind: "PHONE", code: next.sandbox_code });
    expect(confirm.status,await confirm.clone().text()).toBe(200);
    expect((await confirm.json()).shop.phone_verified_at).toBeTruthy();
    expect((await owner("/setup/verify/confirm", "POST", { kind: "PHONE", code: next.sandbox_code })).status).toBe(409);
  });
  it("resumes progress, handles malformed old state and deduplicates starter services", async () => {
    await db.prepare("UPDATE shops SET setup_json=? WHERE id=?").bind('{"done":"bad","skipped":null}',id).run();
    expect((await owner("/setup")).status).toBe(200);
    await owner("/setup/state", "PUT", { done: "shop", step: "brand" });
    await owner("/setup/state", "PUT", { done: "brand", step: "hours" });
    const state = (await (await owner("/setup")).json()).state;
    expect(state.done).toEqual(["shop","brand"]); expect(state.step).toBe("hours");
    await owner("/setup/state", "PUT", { skipped: "brand" });
    expect((await (await owner("/setup")).json()).state.done).toEqual(["shop"]);
    const row = { name: "Test Cut", category: "", duration_min: 30, price_pence: 2000 };
    const added = await owner("/setup/starter", "POST", { services: [row,{ ...row, name: "test cut" }] });
    expect(added.status,await added.clone().text()).toBe(201); expect((await added.json()).added).toBe(1);
    expect((await (await owner("/setup/starter", "POST", { services: [row] })).json()).added).toBe(0);
    expect((await owner("/setup/starter", "POST", { services: [{ ...row, duration_min: 1 }] })).status).toBe(400);
  });
  it("saves terms before choosing a booking address, preserving zero notice and checking versions", async () => {
    const w = await (await owner("/workspace")).json();
    const rules = { deposit_pence: 0, cancel_hours: 0, no_show_grace: 10, payment_mode: "PAY_AT_VISIT", lead_time_min: 0, booking_window_days: 28, terms_text: "Please arrive on time.", version: w.shop.version };
    const r = await owner("/setup/policy", "PUT", rules);
    expect(r.status,await r.clone().text()).toBe(200);
    expect((await r.json()).shop).toMatchObject({ slug: null, cancel_hours: 0, lead_time_min: 0, terms_text: rules.terms_text, terms_version: 1 });
    expect((await owner("/setup/policy", "PUT", { ...rules, terms_text: "Stale overwrite" })).status).toBe(409);
  });
  it("uploads a real transparent logo, scopes media to the shop and rejects unsupported files", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.8 } } }).png().toBuffer();
    const objects = new Map<string, { body: Uint8Array; contentType: string }>();
    const MEDIA = { put: async (key: string, body: Uint8Array, contentType: string) => { objects.set(key, { body, contentType }); }, get: async (key: string) => objects.get(key) ?? null, delete: async (key: string) => { objects.delete(key); } };
    const upload = (bytes: Uint8Array, type: string, kind = "logo") => {
      const form = new FormData(); form.set("kind",kind); form.set("file",new File([bytes as BlobPart], "upload", { type }));
      return app.request(origin + "/api/app/media", { method: "POST", headers: { origin, cookie }, body: form }, { DB: db, MEDIA });
    };
    const invalid = await upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml");
    expect(invalid.status).toBe(400); expect(objects.size).toBe(0);
    expect((await upload(new Uint8Array(5 * 1024 * 1024 + 1), "image/png")).status).toBe(413);
    const r = await upload(png, "image/png"); expect(r.status,await r.clone().text()).toBe(201);
    const media = (await r.json()).media; uploadedLogo = media.url;
    expect(media).toMatchObject({ kind: "logo", width: 64, height: 32, tone: "light", content_type: "image/png" });
    const object = [...objects.entries()][0]; expect(object[0].startsWith(id + "/logo/")).toBe(true);
    expect((await sharp(object[1].body).metadata()).hasAlpha).toBe(true);
    const mine = await (await owner("/media")).json(); expect(mine.media.map((m: any) => m.id)).toContain(media.id);
    const other = await (await call("/api/app/media", "GET", undefined, ownerCookie)).json(); expect(other.media.map((m: any) => m.id)).not.toContain(media.id);
  });
  it("publishes logo, cover and custom content and rejects an old draft after publication", async () => {
    const { shopPageSchema } = await import("../src/server/domain");
    const initial = shopPageSchema.parse({ version: 0 });
    const form = { ...initial, logo_url: uploadedLogo, cover_url: "/static/stock/brick.webp", copy: { "hero.button": "Choose your cut" }, element_styles: { "hero.title": { fg: "#112233" } } };
    const draftSave = await owner("/shop/page/draft", "PUT", form);
    expect(draftSave.status).toBe(200);
    const { draft_updated_at } = await draftSave.json();
    const r = await owner("/shop/page", "PUT", { ...form, expected_draft_at: draft_updated_at });
    expect(r.status,await r.clone().text()).toBe(200);
    const saved = (await r.json()).page;
    expect(saved.logo_url).toBe(form.logo_url); expect(saved.logo_tone).toBe("light"); expect(saved.draft_json).toBeNull();
    expect(JSON.parse(saved.copy_json)).toEqual(form.copy); expect(JSON.parse(saved.element_styles_json)).toEqual(form.element_styles);
    expect((await owner("/shop/page/draft", "PUT", form)).status).toBe(409);
    await db.prepare("UPDATE shops SET slug='setup-audit', online_booking=1 WHERE id=?").bind(id).run();
    const pub = await call("/api/public/shops/setup-audit/page");
    expect(pub.status,await pub.clone().text()).toBe(200);
    expect((await pub.json()).page).toMatchObject({ logo_url: form.logo_url, cover_url: form.cover_url, copy: form.copy });
  });
  it("discards only the expected page version and blocks delayed drafts afterward", async () => {
    const { shopPageSchema } = await import("../src/server/domain");
    const live = (await (await owner("/shop/page")).json()).page;
    const draft = shopPageSchema.parse({ version: live.version, strapline: "Unpublished draft" });
    const draftSave = await owner("/shop/page/draft", "PUT", draft);
    expect(draftSave.status).toBe(200);
    const { draft_updated_at } = await draftSave.json();
    const discarded = await owner("/shop/page/draft", "DELETE", { version: live.version, expected_draft_at: draft_updated_at });
    expect(discarded.status, await discarded.clone().text()).toBe(200);
    const page = (await discarded.json()).page;
    expect(page.version).toBe(live.version + 1);
    expect(page.draft_json).toBeNull(); expect(page.logo_url).toBe(live.logo_url);
    expect((await owner("/shop/page/draft", "PUT", draft)).status).toBe(409);
    const next = { ...draft, version: page.version, strapline: "New draft" };
    expect((await owner("/shop/page/draft", "PUT", next)).status).toBe(200);
    expect((await owner("/shop/page/draft", "DELETE", { version: live.version })).status).toBe(409);
    const retained = (await (await owner("/shop/page")).json()).page;
    expect(JSON.parse(retained.draft_json).strapline).toBe("New draft");
  });
  it("fences the first autosave even when discard arrives before a page row exists", async () => {
    await db.prepare("DELETE FROM shop_pages WHERE shop_id=?").bind(id).run();
    const discarded = await owner("/shop/page/draft", "DELETE", { version: 0 });
    expect(discarded.status, await discarded.clone().text()).toBe(200);
    expect((await discarded.json()).page.version).toBe(1);
    expect((await owner("/shop/page/draft", "PUT", { version: 0, strapline: "Late first write" })).status).toBe(409);
    expect((await owner("/shop/page/draft", "DELETE", {})).status).toBe(400);
  });

  it("allows only one competing first draft and never stores the concurrency metadata", async () => {
    await db.prepare("DELETE FROM shop_pages WHERE shop_id=?").bind(id).run();
    const pair = await Promise.all(["Editor A", "Editor B"].map(strapline => owner("/shop/page/draft", "PUT", { version: 0, expected_draft_at: null, strapline })));
    expect(pair.map(r => r.status).sort()).toEqual([200, 409]);
    const page = (await (await owner("/shop/page")).json()).page;
    const winner = JSON.parse(page.draft_json);
    expect(winner.strapline).toBe(pair[0].status === 200 ? "Editor A" : "Editor B");
    expect(winner).not.toHaveProperty("expected_draft_at");
    expect(page.version).toBe(0);
    expect(page.draft_updated_at).toBeGreaterThan(0);
  });
  it("advances same-millisecond draft revisions and blocks stale or legacy writes", async () => {
    const page = (await (await owner("/shop/page")).json()).page;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const a = await owner("/shop/page/draft", "PUT", { version: page.version, expected_draft_at: page.draft_updated_at, strapline: "First same-time save" });
      expect(a.status,await a.clone().text()).toBe(200);
      const first = (await a.json()).draft_updated_at;
      const b = await owner("/shop/page/draft", "PUT", { version: page.version, expected_draft_at: first, strapline: "Second same-time save" });
      expect(b.status,await b.clone().text()).toBe(200);
      const second = (await b.json()).draft_updated_at;
      expect(second).toBeGreaterThan(first);
      for (const [path, method] of [["/shop/page/draft", "PUT"], ["/shop/page", "PUT"], ["/shop/page/draft", "DELETE"]]) {
        for (const token of [undefined, null, page.draft_updated_at, first]) {
          const r = await owner(path, method, { version: page.version, expected_draft_at: token });
          expect(r.status,await r.clone().text()).toBe(409);
        }
      }
      expect((await owner("/shop/page/draft", "PUT", { version: page.version, expected_draft_at: -1 })).status).toBe(400);
      const retained = (await (await owner("/shop/page")).json()).page;
      expect(retained.draft_updated_at).toBe(second);
      expect(JSON.parse(retained.draft_json).strapline).toBe("Second same-time save");
    } finally { clock.mockRestore(); }
  });
  it("serializes publication or discard against a concurrent draft with the same revision", async () => {
    for (const action of ["publish", "discard"] as const) {
      const before = (await (await owner("/shop/page")).json()).page;
      const expected = { version: before.version, expected_draft_at: before.draft_updated_at };
      const operations = await Promise.all([
        owner(action === "publish" ? "/shop/page" : "/shop/page/draft", action === "publish" ? "PUT" : "DELETE", expected),
        owner("/shop/page/draft", "PUT", { ...expected, strapline: `Competing ${action} draft` }),
      ]);
      expect(operations.map(r => r.status).sort()).toEqual([200, 409]);
      const after = (await (await owner("/shop/page")).json()).page;
      if (operations[0].status === 200) {
        const response = (await operations[0].json()).page;
        expect(response.version).toBe(before.version + 1);
        expect(response.draft_json).toBeNull();
        expect(response.draft_updated_at).toBeNull();
        expect(after.draft_json).toBeNull();
      } else {
        expect(after.version).toBe(before.version);
        expect(JSON.parse(after.draft_json).strapline).toBe(`Competing ${action} draft`);
      }
    }
  });

});

describe("PWA identity and signup boundaries", () => {
  let barberCookie = "", staffId = "";
  it("requires an invite and legal agreement for staff signup without promoting a shared link to email proof", async () => {
    const created = await call("/api/app/staff", "POST", { name: "PWA Barber", role: "Barber" }, ownerCookie);
    expect(created.status, await created.clone().text()).toBe(201);
    staffId = (await created.json()).id;
    const invited = await call("/api/app/auth/invites", "POST", { staff_id: staffId, email: "pwa-barber@audit.test", role: "BARBER", channel: "LINK" }, ownerCookie);
    expect(invited.status, await invited.clone().text()).toBe(201);
    const { token } = await invited.json();
    const body = { token, name: "PWA Barber", email: "pwa-barber@audit.test", password: "PWA-barber-password", accept_legal: true };
    expect((await call("/api/app/auth/accept", "POST", { ...body, accept_legal: false })).status).toBe(400);
    expect((await call("/api/app/auth/accept", "POST", { ...body, email: "different@audit.test" })).status).toBe(400);
    const accepted = await call("/api/app/auth/accept", "POST", body);
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    barberCookie = cookieOf(accepted, "ollo_session");
    expect(accepted.headers.get("set-cookie")).toContain("HttpOnly");
    expect(accepted.headers.get("set-cookie")).toContain("Secure");
    expect((await db.prepare("SELECT email_verified_at FROM app_users WHERE email=?").bind(body.email).first<any>())!.email_verified_at).toBeNull();
    expect([400,409]).toContain((await call("/api/app/auth/accept", "POST", body)).status);
  });
  it("enforces barber permissions at the API and revokes access when the staff profile is disabled", async () => {
    for (const [path,method,body] of [["/setup","GET",undefined], ["/shop/page","PUT",{ version: 0 }], ["/auth/invites","POST",{ staff_id: staffId, email: "no@audit.test", role: "MANAGER", channel: "LINK" }]] as const) {
      expect((await call(`/api/app${path}`,method,body,barberCookie)).status).toBe(403);
    }
    const w = await call("/api/app/workspace", "GET", undefined, barberCookie);
    expect(w.status).toBe(200);
    const data = await w.json(); expect(data.account).toMatchObject({ role: "BARBER", staff_id: staffId });
    expect(data.bookings.every((b: any) => b.staff_id === staffId)).toBe(true);
    await db.prepare("UPDATE staff SET active=0 WHERE id=?").bind(staffId).run();
    expect((await call("/api/app/workspace","GET",undefined,barberCookie)).status).toBe(401);
  });
  it("rejects revoked and expired invitations and serializes competing acceptance or resend", async () => {
    async function invite(label: string) {
      const staff = await call("/api/app/staff", "POST", { name: `Security ${label}`, role: "Barber" }, ownerCookie);
      expect(staff.status).toBe(201);
      const staffId = (await staff.json()).id;
      const email = `security-${label}@audit.test`;
      const res = await call("/api/app/auth/invites", "POST", { staff_id: staffId, email, role: "BARBER", channel: "LINK" }, ownerCookie);
      expect(res.status, await res.clone().text()).toBe(201);
      const data = await res.json();
      return { ...data, staffId, email, body: { token: data.token, email, name: `Security ${label}`, password: "Secure-invitation-password", accept_legal: true } };
    }
    for (const reason of ["revoked", "expired"]) {
      const i = await invite(reason);
      if (reason === "revoked") expect((await call(`/api/app/auth/invites/${i.id}/revoke`, "POST", {}, ownerCookie)).status).toBe(200);
      else await db.prepare("UPDATE staff_invitations SET expires_at=? WHERE id=?").bind(Date.now()-1, i.id).run();
      expect((await call("/api/app/auth/accept", "POST", i.body)).status).toBe(400);
      expect(await db.prepare("SELECT id FROM app_users WHERE email=?").bind(i.email).first()).toBeNull();
    }
    const one = await invite("race");
    const accepted = await Promise.all([call("/api/app/auth/accept", "POST", one.body), call("/api/app/auth/accept", "POST", one.body)]);
    expect(accepted.map(r => r.status).sort()).toEqual([201,409]);
    expect((await db.prepare("SELECT COUNT(*)::int AS n FROM app_memberships WHERE staff_id=?").bind(one.staffId).first<any>())!.n).toBe(1);
    const revoked = await invite("revoke-race");
    const outcomes = await Promise.all([
      call("/api/app/auth/accept", "POST", revoked.body),
      call(`/api/app/auth/invites/${revoked.id}/revoke`, "POST", {}, ownerCookie),
    ]);
    const row = await db.prepare("SELECT accepted_at,revoked FROM staff_invitations WHERE id=?").bind(revoked.id).first<any>();
    expect(!!row.accepted_at && !!row.revoked).toBe(false);
    if (row.revoked) {
      expect([400,409]).toContain(outcomes[0].status);
      expect(await db.prepare("SELECT id FROM app_users WHERE email=?").bind(revoked.email).first()).toBeNull();
    } else { expect(outcomes.map(r => r.status)).toEqual([201,404]); }
    const resend = await invite("resend-race");
    await db.prepare("UPDATE staff_invitations SET last_sent_at=? WHERE id=?").bind(Date.now()-61000, resend.id).run();
    const resent = await Promise.all([
      call(`/api/app/auth/invites/${resend.id}/resend`, "POST", {}, ownerCookie),
      call(`/api/app/auth/invites/${resend.id}/resend`, "POST", {}, ownerCookie),
    ]);
    expect(resent.filter(r => r.status === 201)).toHaveLength(1);
    expect(resent.every(r => [201,409,429].includes(r.status))).toBe(true);
    expect((await call("/api/app/auth/accept", "POST", resend.body)).status).toBe(400);
    const replacement = await resent.find(r => r.status === 201)!.json();
    expect((await call("/api/app/auth/accept", "POST", { ...resend.body, token: replacement.token })).status).toBe(201);
  });
  it("keeps customer and workspace sessions separate and revokes push delivery on logout", async () => {
    const customer = await register("07700900771", "pwa-customer@audit.test");
    expect((await call("/api/app/workspace","GET",undefined,customer)).status).toBe(401);
    const ownerInCustomer = await call(`${A}/session`,"GET",undefined,ownerCookie);
    expect((await ownerInCustomer.json()).profile).toBeNull();
    const account = (await db.prepare("SELECT id FROM customer_accounts WHERE email=?").bind("pwa-customer@audit.test").first<any>())!.id;
    const endpoint = "https://fcm.googleapis.com/fcm/send/pwa-audit";
    const push = await call(`${A}/push`,"POST", { endpoint, keys: { p256dh: "a".repeat(80), auth: "b".repeat(24) } },customer);
    expect(push.status,await push.clone().text()).toBe(201);
    const logout = await call(`${A}/logout`,"POST", { endpoint },customer);
    expect(logout.status).toBe(200);
    expect(await db.prepare("SELECT id FROM customer_push_subscriptions WHERE account_id=? AND shop_id=?").bind(account,shopId).first()).toBeNull();
    expect((await (await call(`${A}/session`,"GET",undefined,customer)).json()).profile).toBeNull();
    expect((await call(`${A}/push`,"POST", { endpoint, keys: { p256dh: "a".repeat(80), auth: "b".repeat(24) } },customer)).status).toBe(401);
  });
});
