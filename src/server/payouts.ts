// Pay runs that move money. foliyo is the Stripe Connect platform: card money is charged on the
// platform balance; approving a pay run transfers the barber's share to the barber's Express account
// and the shop's share to the shop's, tagged with one transfer_group. Cash never enters — it shows as
// a residual to settle by hand. Refunds and disputes create reversals, never edits.
//
// Tiers: STANDARD transfers only what has settled (Stripe would reject otherwise — we check the
// available balance); FAST transfers against the platform float straight after approval.
import type { Database as DB } from "../db/client";
import type { PayRun, PayTerms, Shop, Staff } from "./domain";
import { calculatePayRun, commissionFor } from "./domain";
import {
  accountLink,
  accountStatus,
  snapshotOf,
  createExpressAccount,
  createTransfer,
  loginLink,
  platformBalance,
  reverseTransfer,
  stripeConnect,
  stripeLive,
  type AccountSnapshot,
  type OwnerType,
} from "./stripe";

export type ConnectedAccount = {
  id: string; shop_id: string; owner_type: OwnerType; owner_id: string; email: string;
  details_submitted: number; charges_enabled: number; payouts_enabled: number; requirements_json: string;
  payout_schedule: string; disabled_reason: string; created_at: number; updated_at: number;
};
export type PlatformPayments = { fee_bps: number; fee_fixed_pence: number; fast_payouts: number; float_alert_pence: number };

export async function platformPolicy(db: DB): Promise<PlatformPayments> {
  const row = await db.prepare("SELECT fee_bps, fee_fixed_pence, fast_payouts, float_alert_pence FROM platform_payments WHERE id=1").first<PlatformPayments>();
  return row ?? { fee_bps: 150, fee_fixed_pence: 0, fast_payouts: 1, float_alert_pence: 200000 };
}

// ---- Connected accounts ---------------------------------------------------------------------------
export async function accountFor(db: DB, shopId: string, ownerType: OwnerType, ownerId: string) {
  return db.prepare("SELECT * FROM connected_accounts WHERE shop_id=? AND owner_type=? AND owner_id=?").bind(shopId, ownerType, ownerId).first<ConnectedAccount>();
}
export async function accountsForShop(db: DB, shopId: string) {
  return (await db.prepare("SELECT * FROM connected_accounts WHERE shop_id=? ORDER BY owner_type, created_at").bind(shopId).all<ConnectedAccount>()).results;
}
// Create (once) and return an onboarding link. Works for the shop and for each barber.
export async function beginOnboarding(db: DB, shop: Shop, owner: { type: OwnerType; id: string; name: string; email: string }, origin: string, returnPath: string) {
  if (!stripeLive()) throw new Error("stripe_off");
  let acct = await accountFor(db, shop.id, owner.type, owner.id);
  const now = Date.now();
  if (!acct) {
    const created = await createExpressAccount({ shopId: shop.id, ownerType: owner.type, ownerId: owner.id, email: owner.email, name: owner.type === "SHOP" ? shop.name : `${owner.name} · ${shop.name}`, country: shop.currency === "GBP" ? "GB" : undefined, individual: owner.type === "STAFF" });
    await db.prepare("INSERT INTO connected_accounts(id,shop_id,owner_type,owner_id,email,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(shop_id,owner_type,owner_id) DO NOTHING").bind(created.id, shop.id, owner.type, owner.id, owner.email, now, now).run();
    if (owner.type === "SHOP") await db.prepare("UPDATE shops SET stripe_account_id=? WHERE id=? AND stripe_account_id=''").bind(created.id, shop.id).run();
    acct = (await accountFor(db, shop.id, owner.type, owner.id))!;
  }
  const link = await accountLink(acct.id, origin, returnPath, returnPath.replace("return", "refresh"));
  return { account: acct, url: link.url };
}
// Pull the live state from Stripe (also what account.updated writes).
export async function refreshAccount(db: DB, accountId: string, snap?: AccountSnapshot) {
  const s = snap ?? (await accountStatus(accountId));
  await db
    .prepare("UPDATE connected_accounts SET details_submitted=?, charges_enabled=?, payouts_enabled=?, requirements_json=?, payout_schedule=?, disabled_reason=?, updated_at=? WHERE id=?")
    .bind(s.details_submitted ? 1 : 0, s.charges_enabled ? 1 : 0, s.payouts_enabled ? 1 : 0, JSON.stringify(s.due), s.payout_schedule, s.disabled_reason, Date.now(), accountId)
    .run();
  return s;
}
export async function dashboardLink(accountId: string) {
  return (await loginLink(accountId)).url;
}
// Human-readable state for the UI.
export function accountState(a: ConnectedAccount | null): { key: "none" | "onboarding" | "restricted" | "active"; label: string } {
  if (!a) return { key: "none", label: "Not connected" };
  if (!a.details_submitted) return { key: "onboarding", label: "Finish setting up" };
  if (!a.payouts_enabled) return { key: "restricted", label: a.disabled_reason ? `Restricted: ${a.disabled_reason.replace(/_/g, " ")}` : "Payouts paused: Stripe needs more details" };
  return { key: "active", label: `Active · pays out ${a.payout_schedule}` };
}

// ---- Pay run figures with card/cash split ------------------------------------------------------------
export type SplitFigures = {
  service_pence: number; tips_pence: number; visits: number;
  card_service_pence: number; card_tips_pence: number; cash_service_pence: number; cash_tips_pence: number;
  platform_fee_pence: number; stripe_fee_pence: number;
  payment_ids: string[];
};
// CARD via Terminal and ONLINE deposits are "card" (on the platform balance); CASH/TRANSFER/VOUCHER
// are "cash" (in someone's hand already). Only unsettled rows (no pay_run_id) count.
export async function splitFigures(db: DB, shopId: string, staffId: string, from: string, to: string): Promise<SplitFigures> {
  const rows = (await db
    .prepare("SELECT id, method, service_pence, tip_pence, platform_fee_pence, stripe_fee_pence, stripe_payment_intent FROM payments WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ? AND voided_at IS NULL AND pay_run_id IS NULL")
    .bind(shopId, staffId, from, to)
    .all<{ id: string; method: string; service_pence: number; tip_pence: number; platform_fee_pence: number; stripe_fee_pence: number; stripe_payment_intent: string }>()).results;
  const f: SplitFigures = { service_pence: 0, tips_pence: 0, visits: 0, card_service_pence: 0, card_tips_pence: 0, cash_service_pence: 0, cash_tips_pence: 0, platform_fee_pence: 0, stripe_fee_pence: 0, payment_ids: [] };
  const bookings = new Set<string>();
  for (const r of rows) {
    const card = r.method === "ONLINE" || (r.method === "CARD" && !!r.stripe_payment_intent);
    f.service_pence += r.service_pence; f.tips_pence += r.tip_pence;
    if (card) { f.card_service_pence += r.service_pence; f.card_tips_pence += r.tip_pence; } else { f.cash_service_pence += r.service_pence; f.cash_tips_pence += r.tip_pence; }
    f.platform_fee_pence += r.platform_fee_pence; f.stripe_fee_pence += r.stripe_fee_pence;
    f.payment_ids.push(r.id);
    bookings.add(r.id);
  }
  f.visits = bookings.size;
  return f;
}

// Given the classic result (what the barber is owed in total) and the split, decide what foliyo moves.
//   barber transfer  = barber's share of CARD money (commission on card service + card tips × share)
//   shop transfer    = card money − barber transfer − platform fee (what's left is the shop's)
//   cash residual    = (total owed to barber) − (barber transfer) − (cash the barber physically holds)
//                      + → shop still owes barber by hand; − → barber owes shop (e.g. chair rent)
// For CHAIR_RENT the barber's own takings are theirs: all card money goes to the barber less rent.
export function settlementFor(terms: PayTerms, result: ReturnType<typeof calculatePayRun>, f: SplitFigures, opts: { reserve_bps: number; cashHeldBy: "BARBER" | "SHOP" }) {
  const cardTipShare = Math.round((f.card_tips_pence * terms.tip_share_pct) / 100);
  let barberCard: number;
  let shopCard: number;
  if (terms.pay_model === "CHAIR_RENT") {
    // Barber keeps card takings; rent is netted from them first.
    barberCard = Math.max(0, f.card_service_pence + cardTipShare - result.rent_pence);
    shopCard = f.card_service_pence + f.card_tips_pence - f.platform_fee_pence - barberCard;
  } else {
    const commissionOnCard = terms.pay_model === "HOURLY" || terms.pay_model === "SALARY" ? 0 : commissionFor(terms, f.card_service_pence);
    // Base/hourly pay is a shop cost paid from whatever is available; card money first.
    const fixedPay = result.base_pence + result.hourly_pence;
    barberCard = Math.min(f.card_service_pence + cardTipShare, commissionOnCard + cardTipShare + fixedPay);
    shopCard = f.card_service_pence + f.card_tips_pence - f.platform_fee_pence - barberCard;
  }
  const reserve = Math.round((barberCard * opts.reserve_bps) / 10000);
  const transfer = Math.max(0, barberCard - reserve);
  const shopTransfer = Math.max(0, shopCard);
  const cashHeld = opts.cashHeldBy === "BARBER" ? f.cash_service_pence + f.cash_tips_pence : 0;
  // Everything the barber is owed that hasn't gone by card and isn't already in their pocket.
  const cashResidual = result.net_pence - barberCard - cashHeld + (terms.pay_model === "CHAIR_RENT" ? 0 : 0);
  return { transfer_pence: transfer, shop_transfer_pence: shopTransfer, reserve_pence: reserve, cash_residual_pence: cashResidual, barber_card_pence: barberCard };
}

// ---- Executing a run ------------------------------------------------------------------------------------
export type TransferOutcome = { ok: boolean; transferred: { to: OwnerType; id: string; amount: number }[]; skipped: string[]; error?: string };
// Move the money for an APPROVED run. Idempotent (keys on run id). Marks the payments settled.
export async function executeRun(db: DB, shop: Shop, run: PayRun, staff: Staff, actor: string, opts: { force?: boolean } = {}): Promise<TransferOutcome> {
  const out: TransferOutcome = { ok: false, transferred: [], skipped: [] };
  if (!stripeLive() || !stripeConnect()) return { ...out, error: "Card payouts are not set up on this deployment" };
  if (run.status !== "APPROVED") return { ...out, error: "Only approved runs can be transferred" };
  const barberAcct = await accountFor(db, shop.id, "STAFF", staff.id);
  const shopAcct = await accountFor(db, shop.id, "SHOP", shop.id);
  const total = (run.transfer_pence || 0) + (run.shop_transfer_pence || 0);
  // STANDARD tier: only spend settled funds. FAST: spend against the float (Stripe rejects if the
  // platform balance can't cover it, and we surface that).
  const policy = await platformPolicy(db);
  const tier = (shop.payout_tier ?? "STANDARD") as "STANDARD" | "FAST";
  if (!opts.force) {
    const bal = await platformBalance().catch(() => null);
    if (!bal) return { ...out, error: "Could not read the Stripe balance" };
    if (bal.available_pence < total) {
      if (tier === "STANDARD" || !policy.fast_payouts) return { ...out, error: `Waiting for card settlement: ${total}p needed, ${bal.available_pence}p available` };
    }
  }
  const group = run.transfer_group || `payrun_${run.id}`;
  const currency = shop.currency || "GBP";
  const now = Date.now();
  const legs: { to: OwnerType; acct: ConnectedAccount | null; amount: number; ownerId: string }[] = [
    { to: "STAFF", acct: barberAcct, amount: run.transfer_pence || 0, ownerId: staff.id },
    { to: "SHOP", acct: shopAcct, amount: run.shop_transfer_pence || 0, ownerId: shop.id },
  ];
  for (const leg of legs) {
    if (leg.amount <= 0) continue;
    if (!leg.acct || !leg.acct.payouts_enabled) { out.skipped.push(leg.to === "STAFF" ? `${staff.name} has not finished Stripe setup — their ${leg.amount}p stays on the platform` : `Shop has not finished Stripe setup — ${leg.amount}p stays on the platform`); continue; }
    const existing = await db.prepare("SELECT id FROM transfers WHERE pay_run_id=? AND owner_type=? AND kind='PAYOUT'").bind(run.id, leg.to).first<{ id: string }>();
    if (existing) { out.transferred.push({ to: leg.to, id: existing.id, amount: leg.amount }); continue; }
    try {
      const t = await createTransfer({
        amountPence: leg.amount, destination: leg.acct.id, currency, group,
        description: `${shop.name} · ${leg.to === "STAFF" ? staff.name : "shop share"} · ${run.period_from}..${run.period_to}`,
        metadata: { shop_id: shop.id, pay_run_id: run.id, owner_type: leg.to, owner_id: leg.ownerId },
        idempotency: `payrun-${run.id}-${leg.to}`,
      });
      await db.prepare("INSERT INTO transfers(id,shop_id,pay_run_id,account_id,owner_type,owner_id,kind,amount_pence,currency,transfer_group,reason,status,created_by,created_at) VALUES(?,?,?,?,?,?,'PAYOUT',?,?,?,?,'CREATED',?,?) ON CONFLICT(id) DO NOTHING")
        .bind(t.id, shop.id, run.id, leg.acct.id, leg.to, leg.ownerId, leg.amount, currency, group, `Pay run ${run.period_from}..${run.period_to}`, actor, now).run();
      out.transferred.push({ to: leg.to, id: t.id, amount: leg.amount });
    } catch (err) {
      return { ...out, error: `Stripe refused the ${leg.to === "STAFF" ? "barber" : "shop"} transfer: ${err instanceof Error ? err.message : "error"}` };
    }
  }
  // Settle the payments into this run so they can't be paid twice, and advance the run.
  await db.batch([
    db.prepare("UPDATE payments SET pay_run_id=? WHERE shop_id=? AND staff_id=? AND date BETWEEN ? AND ? AND voided_at IS NULL AND pay_run_id IS NULL").bind(run.id, shop.id, staff.id, run.period_from, run.period_to),
    db.prepare("UPDATE pay_runs SET status='TRANSFERRED', transfer_group=?, transferred_at=?, updated_at=?, version=version+1 WHERE shop_id=? AND id=? AND status='APPROVED'").bind(group, now, now, shop.id, run.id),
    db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), shop.id, "pay_run", run.id, "PAY_RUN_TRANSFERRED", actor, `${out.transferred.map((t) => `${t.to === "STAFF" ? staff.name : "shop"} ${t.amount}p (${t.id})`).join("; ") || "nothing to move"}${out.skipped.length ? `. Held: ${out.skipped.join("; ")}` : ""}`, now),
  ]);
  out.ok = true;
  return out;
}

// A refund or dispute on a settled card payment: claw back proportionally from the run's transfers.
export async function reverseForPayment(db: DB, shopId: string, paymentId: string, amountPence: number, reason: string, actor: string) {
  const p = await db.prepare("SELECT pay_run_id, staff_id, service_pence, tip_pence FROM payments WHERE shop_id=? AND id=?").bind(shopId, paymentId).first<{ pay_run_id: string | null; staff_id: string; service_pence: number; tip_pence: number }>();
  if (!p?.pay_run_id) return { reversed: [] as string[], note: "not yet settled — excluded from the next run" };
  const run = await db.prepare("SELECT * FROM pay_runs WHERE shop_id=? AND id=?").bind(shopId, p.pay_run_id).first<PayRun>();
  if (!run) return { reversed: [], note: "run missing" };
  const transfers = (await db.prepare("SELECT * FROM transfers WHERE pay_run_id=? AND kind='PAYOUT'").bind(run.id).all<{ id: string; owner_type: OwnerType; account_id: string; owner_id: string; amount_pence: number }>()).results;
  const cardTotal = (run.card_service_pence || 0) + (run.card_tips_pence || 0);
  if (!cardTotal) return { reversed: [], note: "no card money in that run" };
  const reversed: string[] = [];
  const now = Date.now();
  for (const t of transfers) {
    const share = Math.min(t.amount_pence, Math.round((amountPence * t.amount_pence) / cardTotal));
    if (share <= 0) continue;
    try {
      const r = await reverseTransfer(t.id, share, reason, `rev-${paymentId}-${t.id}`);
      await db.prepare("INSERT INTO transfers(id,shop_id,pay_run_id,account_id,owner_type,owner_id,kind,amount_pence,currency,transfer_group,reverses,reason,status,created_by,created_at) VALUES(?,?,?,?,?,?,'REVERSAL',?,?,?,?,?,'CREATED',?,?) ON CONFLICT(id) DO NOTHING")
        .bind(r.id, shopId, run.id, t.account_id, t.owner_type, t.owner_id, -share, "GBP", run.transfer_group, t.id, reason, actor, now).run();
      reversed.push(r.id);
    } catch (err) {
      await db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), shopId, "pay_run", run.id, "REVERSAL_FAILED", actor, `Could not reverse ${share}p from ${t.id}: ${err instanceof Error ? err.message : "error"}`, now).run();
    }
  }
  return { reversed, note: reversed.length ? `reversed ${reversed.length} transfer(s)` : "nothing reversed" };
}

// ---- Wallet views --------------------------------------------------------------------------------------
// Four honest lines: earned (ledger), transferred (foliyo moved it), paid out (reached the bank), cash.
export async function walletFor(db: DB, shopId: string, owner: { type: OwnerType; id: string }, from: string, to: string) {
  const acct = await accountFor(db, shopId, owner.type, owner.id);
  const transfers = await db
    .prepare("SELECT COALESCE(SUM(CASE WHEN kind='PAYOUT' THEN amount_pence ELSE 0 END),0)::int AS out, COALESCE(SUM(CASE WHEN kind='REVERSAL' THEN amount_pence ELSE 0 END),0)::int AS back FROM transfers WHERE shop_id=? AND owner_type=? AND owner_id=? AND created_at BETWEEN ? AND ?")
    .bind(shopId, owner.type, owner.id, Date.parse(from), Date.parse(to) + 86400000)
    .first<{ out: number; back: number }>();
  const payouts = acct
    ? await db.prepare("SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount_pence ELSE 0 END),0)::int AS paid, COALESCE(SUM(CASE WHEN status IN ('pending','in_transit') THEN amount_pence ELSE 0 END),0)::int AS in_transit FROM payouts WHERE account_id=? AND created_at BETWEEN ? AND ?").bind(acct.id, Date.parse(from), Date.parse(to) + 86400000).first<{ paid: number; in_transit: number }>()
    : { paid: 0, in_transit: 0 };
  const recent = await db
    .prepare("SELECT t.*, r.period_from, r.period_to FROM transfers t LEFT JOIN pay_runs r ON r.id=t.pay_run_id WHERE t.shop_id=? AND t.owner_type=? AND t.owner_id=? ORDER BY t.created_at DESC LIMIT 30")
    .bind(shopId, owner.type, owner.id)
    .all();
  return {
    account: acct,
    state: accountState(acct),
    transferred_pence: (transfers?.out ?? 0) + (transfers?.back ?? 0),
    paid_out_pence: payouts?.paid ?? 0,
    in_transit_pence: payouts?.in_transit ?? 0,
    transfers: recent.results,
  };
}

// ---- Scheduled runs -----------------------------------------------------------------------------------
// Shops with payrun_auto DAILY/WEEKLY get runs drafted, approved and transferred for the period just
// ended. Called from the sweep. Returns how many runs it created.
export async function scheduledPayRuns(db: DB, now = Date.now()) {
  if (!stripeLive() || !stripeConnect()) return 0;
  const { draftAndApproveRun } = await import("./sandbox"); // late import: sandbox imports this module
  const shops = (await db.prepare("SELECT * FROM shops WHERE payrun_auto<>'OFF'").all<Shop>()).results;
  let n = 0;
  for (const shop of shops) {
    const today = new Date(now).toLocaleDateString("en-CA", { timeZone: shop.timezone });
    const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
    let from = yesterday, to = yesterday;
    if (shop.payrun_auto === "WEEKLY") {
      if (new Date(today + "T12:00:00Z").getUTCDay() !== 1) continue; // Mondays: last Mon–Sun
      from = new Date(Date.parse(yesterday) - 6 * 86400000).toISOString().slice(0, 10);
    }
    const staff = (await db.prepare("SELECT * FROM staff WHERE shop_id=? AND active=1").bind(shop.id).all<Staff>()).results;
    for (const s of staff) {
      const exists = await db.prepare("SELECT 1 FROM pay_runs WHERE shop_id=? AND staff_id=? AND period_from=? AND period_to=? AND status<>'VOID'").bind(shop.id, s.id, from, to).first();
      if (exists) continue;
      const run = await draftAndApproveRun(db, shop, s, from, to);
      if (!run) continue;
      await executeRun(db, shop, run, s, "system");
      n++;
    }
  }
  return n;
}

// ---- Webhook: account / transfer / payout / dispute / refund events ------------------------------------
export type ConnectEvent = { id: string; type: string; account?: string; data: { object: Record<string, unknown> } };
export async function handleConnectEvent(db: DB, evt: ConnectEvent) {
  const o = evt.data.object as Record<string, unknown> & { id: string };
  const now = Date.now();
  switch (evt.type) {
    case "account.updated": {
      const known = await db.prepare("SELECT id FROM connected_accounts WHERE id=?").bind(o.id).first();
      if (known) await refreshAccount(db, o.id, snapshotOf(o as Parameters<typeof snapshotOf>[0]));
      return;
    }
    case "transfer.created":
    case "transfer.updated":
      await db.prepare("UPDATE transfers SET status='PAID' WHERE id=? AND status='CREATED'").bind(o.id).run();
      return;
    case "transfer.reversed":
      await db.prepare("UPDATE transfers SET status='REVERSED' WHERE id=?").bind(o.id).run();
      return;
    case "payout.created":
    case "payout.updated":
    case "payout.paid":
    case "payout.failed":
    case "payout.canceled": {
      // Connect payouts arrive with evt.account = the connected account they belong to.
      const acct = evt.account || "";
      if (!acct) return;
      const arrival = typeof o.arrival_date === "number" ? new Date((o.arrival_date as number) * 1000).toISOString().slice(0, 10) : "";
      await db
        .prepare("INSERT INTO payouts(id,account_id,amount_pence,currency,status,arrival_date,method,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, arrival_date=excluded.arrival_date, updated_at=excluded.updated_at")
        .bind(o.id, acct, Number(o.amount) || 0, String(o.currency || "gbp").toUpperCase(), String(o.status || "pending"), arrival, String(o.method || "standard"), now, now)
        .run();
      return;
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      const charge = String(o.charge || "");
      const pi = typeof o.payment_intent === "string" ? o.payment_intent : "";
      const pay = await db.prepare("SELECT id, shop_id FROM payments WHERE (stripe_charge=? AND stripe_charge<>'') OR (stripe_payment_intent=? AND stripe_payment_intent<>'') LIMIT 1").bind(charge, pi).first<{ id: string; shop_id: string }>();
      const booking = !pay && pi ? await db.prepare("SELECT id, shop_id FROM bookings WHERE stripe_payment_intent=?").bind(pi).first<{ id: string; shop_id: string }>() : null;
      const shopId = pay?.shop_id || booking?.shop_id || "";
      if (!shopId) return;
      await db
        .prepare("INSERT INTO disputes(id,shop_id,payment_id,charge,amount_pence,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at")
        .bind(o.id, shopId, pay?.id ?? null, charge, Number(o.amount) || 0, String(o.status || "needs_response"), String(o.reason || ""), now, now)
        .run();
      // Money has left the platform: claw back the shares once, when the dispute opens.
      if (evt.type === "charge.dispute.created" && pay) {
        const r = await reverseForPayment(db, shopId, pay.id, Number(o.amount) || 0, `dispute ${o.id}`, "stripe");
        await db.prepare("UPDATE disputes SET reversed=? WHERE id=?").bind(r.reversed.length ? 1 : 0, o.id).run();
        await db.prepare("INSERT INTO audit_events (id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .bind(crypto.randomUUID(), shopId, "payment", pay.id, "DISPUTE_OPENED", "stripe", `Customer disputed ${o.amount}p (${o.reason}). ${r.note}. Respond in the Stripe dashboard.`, now).run();
      }
      return;
    }
    case "charge.refunded": {
      // Refunds we did not initiate from the app (e.g. from the Stripe dashboard) still need reversing.
      const pi = typeof o.payment_intent === "string" ? o.payment_intent : "";
      if (!pi) return;
      const pay = await db.prepare("SELECT id, shop_id, pay_run_id FROM payments WHERE stripe_payment_intent=? AND voided_at IS NULL").bind(pi).first<{ id: string; shop_id: string; pay_run_id: string | null }>();
      if (pay?.pay_run_id) await reverseForPayment(db, pay.shop_id, pay.id, Number(o.amount_refunded) || 0, "refund from Stripe dashboard", "stripe");
      return;
    }
    default:
      return;
  }
}
