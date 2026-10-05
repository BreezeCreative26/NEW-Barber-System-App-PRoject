// Foliyo's advertised shop fees. Provider costs never form part of a customer response.
import type { Database as DB } from "../db/client";
import { HTTPException } from "hono/http-exception";

export type FeeRule = { scope: string; shop_id: string | null; fee_bps: number; fixed_pence: number; use_default: number; version: number; updated_at: number };
export type EffectiveFee = { fee_bps: number; fixed_pence: number; rule_scope: string; rule_version: number };
const conflict = (message: string): never => { throw new HTTPException(409, { message }); };
export function feeAmount(gross: number, rule: Pick<EffectiveFee, "fee_bps" | "fixed_pence">) {
  if (!Number.isSafeInteger(gross) || gross < 0) throw new Error("Invalid fee basis");
  return gross === 0 ? 0 : Math.min(gross, Math.round(gross * rule.fee_bps / 10000) + rule.fixed_pence);
}
export async function effectiveFee(db: DB, shopId: string): Promise<EffectiveFee> {
  const rule = await db.prepare("SELECT * FROM foliyo_effective_fee(?)").bind(shopId).first<EffectiveFee>();
  if (!rule) throw new Error("Fee configuration missing");
  return rule;
}
// Store before a provider call; triggers also cover booking creation and legacy callers.
export async function quoteFee(db: DB, shopId: string, kind: "CHAIR" | "BOOKING", sourceId: string) {
  await db.prepare(`INSERT INTO foliyo_fee_quotes(id,shop_id,source_type,source_id,fee_bps,fixed_pence,rule_scope,rule_version,created_at)
    SELECT ?,?,?,?,f.fee_bps,f.fixed_pence,f.rule_scope,f.rule_version,? FROM foliyo_effective_fee(?) f
    ON CONFLICT(source_type,source_id) DO NOTHING`).bind(`${kind}:${sourceId}`, shopId, kind, sourceId, Date.now(), shopId).run();
  const rule = await db.prepare("SELECT fee_bps,fixed_pence,rule_scope,rule_version FROM foliyo_fee_quotes WHERE shop_id=? AND source_type=? AND source_id=?").bind(shopId, kind, sourceId).first<EffectiveFee>();
  if (!rule) conflict("Fee quote belongs to a different shop");
  return rule!;
}
export async function quotedFeeAmount(db: DB, shopId: string, kind: "CHAIR" | "BOOKING", sourceId: string, gross: number) {
  const q = await db.prepare("SELECT fee_bps,fixed_pence,rule_scope,rule_version FROM foliyo_fee_quotes WHERE shop_id=? AND source_type=? AND source_id=?").bind(shopId, kind, sourceId).first<EffectiveFee>();
  if (!q) conflict("Payment fee snapshot missing; reconcile this payment before continuing");
  return feeAmount(gross, q!);
}
async function adminAudit(db: DB, adminId: string, shopId: string | null, action: string, before: unknown, after: unknown, reason: string) {
  await db.prepare("INSERT INTO admin_audit(id,admin_id,shop_id,action,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), adminId, shopId, action, JSON.stringify(before), JSON.stringify(after), reason, Date.now()).run();
}
export async function setFeeRule(db: DB, adminId: string, scope: string, change: { version: number; fee_bps: number; fixed_pence: number; use_default: boolean; reason: string; reset_overrides?: boolean }) {
  return db.transaction(async tx => {
    await tx.prepare("SELECT pg_advisory_xact_lock(7410042)").first();
    const shopId = scope === "default" ? null : scope;
    if (shopId) {
      const shop = await tx.prepare("SELECT currency FROM shops WHERE id=?").bind(shopId).first<{ currency: string }>();
      if (!shop) throw new HTTPException(404, { message: "Shop not found" });
      if (shop.currency !== "GBP" && change.fixed_pence > 0 && !change.use_default) conflict("Fixed fees are supported only for GBP shops; use a percentage fee");
    }
    const before = await tx.prepare("SELECT * FROM foliyo_fee_rules WHERE scope=?").bind(scope).first<FeeRule>();
    if ((before?.version ?? 0) !== change.version) conflict("Fees changed in another session. Refresh before saving.");
    if (!shopId && change.use_default) conflict("The platform default cannot inherit itself");
    await tx.prepare(`INSERT INTO foliyo_fee_rules(scope,shop_id,fee_bps,fixed_pence,use_default,version,updated_at) VALUES(?,?,?,?,?,1,?)
      ON CONFLICT(scope) DO UPDATE SET fee_bps=excluded.fee_bps,fixed_pence=excluded.fixed_pence,use_default=excluded.use_default,version=foliyo_fee_rules.version+1,updated_at=excluded.updated_at`)
      .bind(scope, shopId, change.fee_bps, change.fixed_pence, change.use_default ? 1 : 0, Date.now()).run();
    if (!shopId) {
      // Keep older integrations on the same published default; shop-aware consumers use effectiveFee.
      await tx.prepare("UPDATE platform_payments SET fee_bps=?,fee_fixed_pence=?,updated_at=? WHERE id=1").bind(change.fee_bps, change.fixed_pence, Date.now()).run();
      if (change.reset_overrides) {
        const overrides = (await tx.prepare("SELECT * FROM foliyo_fee_rules WHERE shop_id IS NOT NULL AND use_default=0").all<FeeRule>()).results;
        await tx.prepare("UPDATE foliyo_fee_rules SET use_default=1,version=version+1,updated_at=? WHERE shop_id IS NOT NULL AND use_default=0").bind(Date.now()).run();
        for (const r of overrides) await adminAudit(tx, adminId, r.shop_id, "FEE_OVERRIDE_RESET", r, { use_default: true }, change.reason);
      }
    }
    const after = await tx.prepare("SELECT * FROM foliyo_fee_rules WHERE scope=?").bind(scope).first<FeeRule>();
    await adminAudit(tx, adminId, shopId, "FEE_RULE_CHANGED", before, after, change.reason);
    return after!;
  });
}
export async function feesOverview(db: DB, search = "") {
  const defaults = await db.prepare("SELECT * FROM foliyo_fee_rules WHERE scope='default'").first<FeeRule>();
  const shops = (await db.prepare(`SELECT s.id,s.name,s.slug,r.fee_bps,r.fixed_pence,r.use_default,COALESCE(r.version,0) AS version,
    f.fee_bps AS effective_bps,f.fixed_pence AS effective_fixed_pence FROM shops s
    LEFT JOIN foliyo_fee_rules r ON r.shop_id=s.id CROSS JOIN LATERAL foliyo_effective_fee(s.id) f
    WHERE s.name ILIKE ? OR s.slug ILIKE ? ORDER BY s.name,s.id LIMIT 100`).bind(`%${search}%`, `%${search}%`).all()).results;
  return { defaults, shops };
}
export type FeeStatement = {
  from: string; to: string; currency: string; label: string;
  charges: { payment_intent: string; booking_id: string; gross_pence: number; fee_pence: number; created_at: number; credited_pence: number }[];
  totals: { gross_pence: number; fee_pence: number; credited_pence: number; count: number };
  credit_destination: string; truncated: boolean;
};
export async function feeStatement(db: DB, shopId: string, from: string, to: string): Promise<FeeStatement> {
  const shop = await db.prepare("SELECT currency FROM shops WHERE id=?").bind(shopId).first<{ currency: string }>();
  if (!shop) throw new HTTPException(404, { message: "Shop not found" });
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`) + 86400000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || !Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== from || new Date(end - 86400000).toISOString().slice(0, 10) !== to || start >= end || end - start > 366 * 86400000) throw new HTTPException(400, { message: "Choose a valid date range of one year or less" });
  const rows = (await db.prepare(`SELECT c.payment_intent,c.booking_id,c.gross_pence,c.fee_pence,c.created_at,
    COALESCE((SELECT SUM(amount_pence) FROM foliyo_fee_credits WHERE payment_intent=c.payment_intent),0)::bigint AS credited_pence
    FROM foliyo_fee_charges c WHERE c.shop_id=? AND c.currency=? AND c.created_at>=? AND c.created_at<? ORDER BY c.created_at DESC,c.payment_intent LIMIT 500`)
    .bind(shopId, shop.currency, start, end).all<FeeStatement["charges"][number]>()).results;
  const totals = (await db.prepare(`SELECT COALESCE(SUM(c.gross_pence),0)::bigint AS gross_pence,COALESCE(SUM(c.fee_pence),0)::bigint AS fee_pence,COUNT(*)::int AS count,
    COALESCE(SUM((SELECT SUM(amount_pence) FROM foliyo_fee_credits WHERE payment_intent=c.payment_intent)),0)::bigint AS credited_pence
    FROM foliyo_fee_charges c WHERE c.shop_id=? AND c.currency=? AND c.created_at>=? AND c.created_at<?`).bind(shopId, shop.currency, start, end).first<FeeStatement["totals"]>())!;
  return { from, to, currency: shop.currency, label: "Foliyo payment fees — deducted from collections, not an additional amount due", charges: rows, totals,
    credit_destination: "Fee corrections are account credits against Foliyo billing, not customer card refunds or wallet cash.", truncated: totals.count > rows.length };
}
export function feeStatementCsv(s: FeeStatement) {
  return ["booking_reference,date,currency,payment_amount,foliyo_fee_deducted,billing_credit",
    ...s.charges.map(r => [r.booking_id.slice(0, 8), new Date(r.created_at).toISOString(), s.currency, (r.gross_pence / 100).toFixed(2), (r.fee_pence / 100).toFixed(2), (r.credited_pence / 100).toFixed(2)].join(","))].join("\n");
}
export async function creditFee(db: DB, adminId: string, shopId: string, input: { request_id: string; payment_intent: string; amount_pence: number; reason: string }) {
  return db.transaction(async tx => {
    // Same lock as the DB limit trigger, so concurrent partial credits cannot over-credit a fee.
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?,0))").bind(`fee-credit:${input.payment_intent}`).first();
    const prior = await tx.prepare("SELECT * FROM foliyo_fee_credits WHERE request_id=?").bind(input.request_id).first<{ shop_id: string; payment_intent: string; amount_pence: number; reason: string; adjustment_id: string }>();
    if (prior) {
      if (prior.shop_id !== shopId || prior.payment_intent !== input.payment_intent || prior.amount_pence !== input.amount_pence || prior.reason !== input.reason) conflict("This correction reference was already used for different details");
      return { adjustment_id: prior.adjustment_id, replay: true };
    }
    const charge = await tx.prepare("SELECT fee_pence,currency,booking_id FROM foliyo_fee_charges WHERE shop_id=? AND payment_intent=?").bind(shopId, input.payment_intent).first<{ fee_pence: number; currency: string; booking_id: string }>();
    if (!charge) throw new HTTPException(404, { message: "Fee charge not found" });
    if (charge.currency !== "GBP") conflict("Billing fee corrections currently support GBP only");
    const used = (await tx.prepare("SELECT COALESCE(SUM(amount_pence),0)::bigint AS n FROM foliyo_fee_credits WHERE payment_intent=?").bind(input.payment_intent).first<{ n: number }>())!.n;
    if (!Number.isSafeInteger(input.amount_pence) || input.amount_pence <= 0 || input.amount_pence > charge.fee_pence - used) conflict("Credit exceeds the remaining Foliyo fee");
    const adjustment = crypto.randomUUID(), now = Date.now();
    await tx.prepare("INSERT INTO invoice_adjustments(id,shop_id,kind,amount_pence,reason,created_by,created_at) VALUES(?,?,'CREDIT',?,?,?,?)")
      .bind(adjustment, shopId, input.amount_pence, `Foliyo fee correction · booking ${charge.booking_id.slice(0, 8)}`, adminId, now).run();
    await tx.prepare("INSERT INTO foliyo_fee_credits(request_id,payment_intent,shop_id,amount_pence,adjustment_id,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(input.request_id, input.payment_intent, shopId, input.amount_pence, adjustment, input.reason, adminId, now).run();
    await adminAudit(tx, adminId, shopId, "FEE_CREDIT_CREATED", { fee_pence: charge.fee_pence, already_credited: used }, { ...input, adjustment_id: adjustment }, input.reason);
    return { adjustment_id: adjustment, replay: false };
  });
}
