// Platform lifecycle: the messages foliyo sends shop owners as their account moves (trial ending,
// trial ended, payment overdue, read-only), alerts foliyo staff should see, broadcasts, and the daily
// MRR snapshot. Everything runs from the 5-minute sweep (`maybeSweep`) so no cron is needed.
import type { Database as DB } from "../db/client";
import { estimate, platformBilling } from "./billing";
import { drain, enqueue, msgShop, providerStatus, type MessageTemplate } from "./messaging";

const uid = () => crypto.randomUUID();
const DAY = 86400000;
const money = (p: number) => `£${(Math.abs(p) / 100).toFixed(2)}`;

// ---- Owner recipients (owner login email; managers not included for account matters) --------------
async function ownerOf(db: DB, shopId: string) {
  return db.prepare("SELECT u.name, u.email FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? AND m.role='OWNER' AND m.active=1 LIMIT 1").bind(shopId).first<{ name: string; email: string }>();
}
async function sendPlatform(db: DB, shopId: string, template: MessageTemplate, vars: Record<string, string | number | null | undefined>, key: string, origin: string, now = Date.now()) {
  const claimed = await db.prepare("INSERT INTO lifecycle_sends(shop_id,key,sent_at) VALUES(?,?,?) ON CONFLICT DO NOTHING").bind(shopId, key, now).run();
  if (!claimed.meta.changes) return false;
  const owner = await ownerOf(db, shopId);
  if (!owner?.email) return false;
  const shop = await msgShop({ env: { DB: db } }, shopId);
  const pb = await platformBilling(db);
  const stmts = enqueue(db, { ...shop, name: pb.company_name || "foliyo" }, { email: owner.email, name: owner.name }, template, { shop: shop.name, ...vars }, { related: { type: "lifecycle", id: `${shopId}:${key}` }, origin, channel: "EMAIL", now, force: true });
  if (stmts.length) { await db.batch(stmts); await drain(db, stmts.length, now, { type: "lifecycle", id: `${shopId}:${key}` }).catch(() => {}); }
  return true;
}

// ---- Trial + dunning sequences --------------------------------------------------------------------
// Trial: day −3 and day 0 ("ended, read-only"). Overdue: day 0, then "read-only" when grace runs out.
// Keys include the trial end / past-due timestamp so an extended trial gets a fresh sequence.
export async function sweepLifecycle(db: DB, origin: string, now = Date.now()) {
  const pb = await platformBilling(db);
  let sent = 0;
  const trials = (await db.prepare("SELECT ss.shop_id, ss.trial_ends_at, s.name FROM shop_subscriptions ss JOIN shops s ON s.id=ss.shop_id WHERE ss.status='TRIAL' AND ss.trial_ends_at IS NOT NULL AND ss.trial_ends_at < ? AND s.suspended_at IS NULL").bind(now + 3 * DAY).all<{ shop_id: string; trial_ends_at: number; name: string }>()).results;
  for (const t of trials) {
    const ends = new Date(t.trial_ends_at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    if (t.trial_ends_at > now) {
      if (await sendPlatform(db, t.shop_id, "trial_ending", { ends, days: Math.max(1, Math.ceil((t.trial_ends_at - now) / DAY)), link: `${origin}/workspace#settings/billing` }, `trial_ending:${t.trial_ends_at}`, origin, now)) sent++;
    } else {
      if (await sendPlatform(db, t.shop_id, "trial_ended", { ends, link: `${origin}/workspace#settings/billing` }, `trial_ended:${t.trial_ends_at}`, origin, now)) {
        sent++;
        await raiseAlert(db, "TRIAL_ENDED", "INFO", t.shop_id, `${t.name}: trial ended without converting`, "They can still sign in; bookings are read-only until a plan is active.", `trial_ended:${t.shop_id}:${t.trial_ends_at}`, now);
      }
    }
  }
  const overdue = (await db.prepare("SELECT ss.shop_id, ss.past_due_since, s.name FROM shop_subscriptions ss JOIN shops s ON s.id=ss.shop_id WHERE ss.status='PAST_DUE' AND ss.past_due_since IS NOT NULL").all<{ shop_id: string; past_due_since: number; name: string }>()).results;
  for (const o of overdue) {
    const inv = await db.prepare("SELECT number, total_pence-paid_pence AS bal, due_at, view_token, id FROM invoices WHERE shop_id=? AND status='OPEN' AND kind<>'CREDIT_NOTE' ORDER BY due_at LIMIT 1").bind(o.shop_id).first<{ number: string; bal: number; due_at: number; view_token: string; id: string }>();
    // No open invoice on file (e.g. marked overdue by hand): fall back to the current estimate.
    const est = inv ? null : await estimate(db, o.shop_id).catch(() => null);
    const number = inv?.number ?? "your subscription";
    const amount = inv ? money(inv.bal) : est ? money(est.total_pence) : "";
    const vars = { number, amount, link: inv ? `${origin}/invoice/${inv.id}?t=${inv.view_token}` : `${origin}/workspace#settings/billing`, grace_days: pb.grace_days, readonly_on: new Date(o.past_due_since + pb.grace_days * DAY).toLocaleDateString("en-GB", { day: "numeric", month: "long" }) };
    if (await sendPlatform(db, o.shop_id, "payment_overdue", vars, `overdue:${o.past_due_since}`, origin, now)) { sent++; await raiseAlert(db, "PAYMENT_OVERDUE", "WARN", o.shop_id, `${o.name}: payment overdue${inv ? ` · ${inv.number} ${money(inv.bal)}` : ""}`, `Reminder sent. Read-only from ${vars.readonly_on}.`, `overdue:${o.shop_id}`, now); }
    if (o.past_due_since + pb.grace_days * DAY < now && (await sendPlatform(db, o.shop_id, "account_readonly", vars, `readonly:${o.past_due_since}`, origin, now))) { sent++; await raiseAlert(db, "ACCOUNT_READONLY", "CRIT", o.shop_id, `${o.name}: now read-only for non-payment`, `${inv?.number ?? "Subscription"} unpaid after ${pb.grace_days}-day grace.`, `readonly:${o.shop_id}`, now); }
  }
  return sent;
}

// ---- Admin alerts --------------------------------------------------------------------------------
export async function raiseAlert(db: DB, kind: string, severity: "INFO" | "WARN" | "CRIT", shopId: string | null, title: string, detail = "", dedupeKey = "", now = Date.now()) {
  await db.prepare("INSERT INTO admin_alerts(id,kind,severity,shop_id,title,detail,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(uid(), kind, severity, shopId, title, detail, dedupeKey, now).run().catch(() => {});
}

// Detect operational problems and raise alerts (deduped while unacknowledged).
export async function sweepAlerts(db: DB, now = Date.now()) {
  // Shops whose messages are failing (≥3 in 24h).
  const failing = (await db.prepare("SELECT n.shop_id, s.name, COUNT(*)::int AS c FROM notifications n JOIN shops s ON s.id=n.shop_id WHERE n.status='FAILED' AND n.created_at>? GROUP BY n.shop_id, s.name HAVING COUNT(*)>=3").bind(now - DAY).all<{ shop_id: string; name: string; c: number }>()).results;
  for (const f of failing) await raiseAlert(db, "MESSAGES_FAILING", "WARN", f.shop_id, `${f.name}: ${f.c} messages failed in 24h`, "Check the shop's Messaging tab and the provider status under Ops.", `msgfail:${f.shop_id}`, now);
  // Provider down (all channels mailbox in production).
  const ps = providerStatus();
  if (process.env.NODE_ENV === "production" && ps.email.provider === "mailbox") await raiseAlert(db, "PROVIDER", "CRIT", null, "Email provider not configured in production", "RESEND_API_KEY is missing — invoices, resets and reminders are not being delivered.", "provider:email", now);
  // Stuck queue.
  const stuck = (await db.prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE status='QUEUED' AND created_at<?").bind(now - 2 * 3600000).first<{ n: number }>())?.n ?? 0;
  if (stuck > 20) await raiseAlert(db, "QUEUE_STUCK", "WARN", null, `${stuck} messages queued for over 2 hours`, "The sweep may not be running, or the provider is rejecting sends.", "queue:stuck", now);
  // Card-payment accounts that lost charges/payouts.
  const conn = (await db.prepare("SELECT ca.shop_id, s.name, ca.disabled_reason FROM connected_accounts ca JOIN shops s ON s.id=ca.shop_id WHERE ca.charges_enabled=0 AND ca.disabled_reason<>''").all<{ shop_id: string; name: string; disabled_reason: string }>().catch(() => ({ results: [] as { shop_id: string; name: string; disabled_reason: string }[] }))).results;
  for (const c of conn) await raiseAlert(db, "CONNECT_DISABLED", "WARN", c.shop_id, `${c.name}: card payments disabled by Stripe`, c.disabled_reason, `connect:${c.shop_id}`, now);
  // Open disputes.
  const disputes = (await db.prepare("SELECT d.shop_id, s.name, COUNT(*)::int AS n FROM disputes d JOIN shops s ON s.id=d.shop_id WHERE d.status NOT IN ('won','lost','warning_closed') GROUP BY d.shop_id, s.name").all<{ shop_id: string; name: string; n: number }>().catch(() => ({ results: [] as { shop_id: string; name: string; n: number }[] }))).results;
  for (const d of disputes) await raiseAlert(db, "DISPUTE", "WARN", d.shop_id, `${d.name}: ${d.n} open dispute${d.n === 1 ? "" : "s"}`, "Evidence is due within Stripe's window.", `dispute:${d.shop_id}`, now);
}

// Email unsent WARN/CRIT alerts to OLLO_ALERT_EMAIL (batched, at most every 30 minutes).
export async function emailAlerts(db: DB, origin: string, now = Date.now()) {
  const to = (process.env.OLLO_ALERT_EMAIL || "").trim();
  if (!to) return 0;
  const rows = (await db.prepare("SELECT * FROM admin_alerts WHERE emailed_at IS NULL AND acked_at IS NULL AND severity IN ('WARN','CRIT') ORDER BY created_at LIMIT 30").all<{ id: string; severity: string; title: string; detail: string }>()).results;
  if (!rows.length) return 0;
  const last = Number((await db.prepare("SELECT value FROM platform_kv WHERE key='alerts_emailed_at'").first<{ value: string }>())?.value || 0);
  if (now - last < 30 * 60000) return 0;
  const anyShop = await db.prepare("SELECT id FROM shops ORDER BY created_at LIMIT 1").first<{ id: string }>();
  if (!anyShop) return 0;
  const shop = await msgShop({ env: { DB: db } }, anyShop.id);
  const pb = await platformBilling(db);
  const stmts = enqueue(db, { ...shop, name: pb.company_name || "foliyo" }, { email: to, name: "foliyo team" }, "admin_alert_digest", { count: rows.length, items: rows.map((r) => `${r.severity === "CRIT" ? "‼" : "!"} ${r.title}${r.detail ? ` — ${r.detail}` : ""}`).join("\n"), link: `${origin}/admin/alerts` }, { related: { type: "admin_alerts", id: String(now) }, origin, channel: "EMAIL", now, force: true });
  if (stmts.length) { await db.batch(stmts); await drain(db, stmts.length, now, { type: "admin_alerts", id: String(now) }).catch(() => {}); }
  await db.prepare("UPDATE admin_alerts SET emailed_at=? WHERE id IN (" + rows.map(() => "?").join(",") + ")").bind(now, ...rows.map((r) => r.id)).run();
  await db.prepare("INSERT INTO platform_kv(key,value,updated_at) VALUES('alerts_emailed_at',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(String(now), now).run();
  return rows.length;
}

// ---- MRR snapshot (once per UTC day) ----------------------------------------------------------------
export async function snapshotMrr(db: DB, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (await db.prepare("SELECT 1 FROM mrr_snapshots WHERE day=?").bind(day).first()) return null;
  const base = (await db.prepare("SELECT ss.status, COUNT(*)::int AS n, COALESCE(SUM(p.monthly_pence + GREATEST(0, ss.seats - p.included_seats) * p.seat_pence),0)::bigint AS pence FROM shop_subscriptions ss JOIN plans p ON p.id=ss.plan_id GROUP BY ss.status").all<{ status: string; n: number; pence: number }>()).results;
  const addons = Number((await db.prepare("SELECT COALESCE(SUM(f.monthly_pence),0)::bigint AS n FROM shop_features sf JOIN features f ON f.key=sf.feature_key JOIN shop_subscriptions ss ON ss.shop_id=sf.shop_id WHERE sf.enabled=1 AND sf.source='ADDON' AND ss.status IN ('ACTIVE','PAST_DUE')").first<{ n: number }>())?.n ?? 0);
  const by = (s: string) => base.find((b) => b.status === s);
  const mrr = Number(by("ACTIVE")?.pence ?? 0) + Number(by("PAST_DUE")?.pence ?? 0) + addons;
  // Yesterday's window (the snapshot describes the day that just finished).
  const [y, m, d] = day.split("-").map(Number);
  const dayStart = Date.UTC(y, m - 1, d) - DAY;
  const newShops = (await db.prepare("SELECT COUNT(*)::int AS n FROM shops WHERE created_at>=? AND created_at<?").bind(dayStart, dayStart + DAY).first<{ n: number }>())?.n ?? 0;
  const converted = (await db.prepare("SELECT COUNT(*)::int AS n FROM shop_subscriptions WHERE activated_at>=? AND activated_at<?").bind(dayStart, dayStart + DAY).first<{ n: number }>())?.n ?? 0;
  const churned = (await db.prepare("SELECT COUNT(*)::int AS n FROM shop_subscriptions WHERE cancelled_at>=? AND cancelled_at<?").bind(dayStart, dayStart + DAY).first<{ n: number }>())?.n ?? 0;
  await db.prepare("INSERT INTO mrr_snapshots(day,mrr_pence,active,trial,past_due,paused,cancelled,new_shops,converted,churned,taken_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(day, mrr, by("ACTIVE")?.n ?? 0, by("TRIAL")?.n ?? 0, by("PAST_DUE")?.n ?? 0, by("PAUSED")?.n ?? 0, by("CANCELLED")?.n ?? 0, newShops, converted, churned, now).run();
  return { day, mrr };
}

// ---- Broadcasts ------------------------------------------------------------------------------------
export type Segment = { status?: string[]; trial_ending_days?: number; feature?: string; shop_ids?: string[]; joined_after?: number; joined_before?: number };
export async function segmentRecipients(db: DB, seg: Segment) {
  const where: string[] = ["m.role='OWNER'", "m.active=1", "s.suspended_at IS NULL"];
  const args: unknown[] = [];
  if (seg.status?.length) { where.push(`ss.status IN (${seg.status.map(() => "?").join(",")})`); args.push(...seg.status); }
  if (seg.trial_ending_days) { where.push("ss.status='TRIAL' AND ss.trial_ends_at BETWEEN ? AND ?"); args.push(Date.now(), Date.now() + seg.trial_ending_days * DAY); }
  if (seg.feature) { where.push("EXISTS (SELECT 1 FROM shop_features sf WHERE sf.shop_id=s.id AND sf.feature_key=? AND sf.enabled=1)"); args.push(seg.feature); }
  if (seg.shop_ids?.length) { where.push(`s.id IN (${seg.shop_ids.map(() => "?").join(",")})`); args.push(...seg.shop_ids); }
  if (seg.joined_after) { where.push("s.created_at>=?"); args.push(seg.joined_after); }
  if (seg.joined_before) { where.push("s.created_at<?"); args.push(seg.joined_before); }
  return (await db.prepare(`SELECT s.id AS shop_id, s.name AS shop, u.name, u.email FROM shops s JOIN shop_subscriptions ss ON ss.shop_id=s.id JOIN app_memberships m ON m.shop_id=s.id JOIN app_users u ON u.id=m.user_id WHERE ${where.join(" AND ")} ORDER BY s.name`).bind(...args).all<{ shop_id: string; shop: string; name: string; email: string }>()).results;
}
export async function sendBroadcast(db: DB, id: string, origin: string, opts: { testTo?: string } = {}) {
  const b = await db.prepare("SELECT * FROM broadcasts WHERE id=?").bind(id).first<{ id: string; subject: string; heading: string; body: string; cta_label: string; cta_url: string; segment_json: string; status: string }>();
  if (!b) throw new Error("Broadcast not found");
  const now = Date.now();
  const pb = await platformBilling(db);
  const anyShop = await db.prepare("SELECT id FROM shops ORDER BY created_at LIMIT 1").first<{ id: string }>();
  const shell = anyShop ? await msgShop({ env: { DB: db } }, anyShop.id) : null;
  const vars = (shopName: string) => ({ shop: shopName, heading: b.heading || b.subject, body: b.body, subject: b.subject, cta_label: b.cta_label, cta_url: b.cta_url });
  if (opts.testTo) {
    if (!shell) throw new Error("No shops yet");
    const stmts = enqueue(db, { ...shell, name: pb.company_name || "foliyo" }, { email: opts.testTo, name: "Test" }, "broadcast", vars("Your shop"), { related: { type: "broadcast_test", id: `${id}:${now}` }, origin, channel: "EMAIL", now, force: true });
    if (stmts.length) { await db.batch(stmts); await drain(db, stmts.length, now, { type: "broadcast_test", id: `${id}:${now}` }).catch(() => {}); }
    await db.prepare("UPDATE broadcasts SET test_sent_to=? WHERE id=?").bind(opts.testTo, id).run();
    return { test: true, to: opts.testTo };
  }
  if (b.status === "SENT") throw new Error("Already sent");
  const rec = await segmentRecipients(db, JSON.parse(b.segment_json || "{}"));
  await db.prepare("UPDATE broadcasts SET status='SENDING', recipients=? WHERE id=?").bind(rec.length, id).run();
  let sent = 0;
  for (const r of rec) {
    const shop = await msgShop({ env: { DB: db } }, r.shop_id);
    const stmts = enqueue(db, { ...shop, name: pb.company_name || "foliyo" }, { email: r.email, name: r.name }, "broadcast", vars(r.shop), { related: { type: "broadcast", id: `${id}:${r.shop_id}` }, origin, channel: "EMAIL", now, force: true });
    if (!stmts.length) continue;
    await db.batch(stmts);
    await db.prepare("INSERT INTO broadcast_recipients(broadcast_id,shop_id,email) VALUES(?,?,?) ON CONFLICT DO NOTHING").bind(id, r.shop_id, r.email).run();
    sent++;
  }
  await drain(db, sent + 5, now).catch(() => {});
  await db.prepare("UPDATE broadcasts SET status='SENT', sent=?, sent_at=? WHERE id=?").bind(sent, now, id).run();
  return { sent, recipients: rec.length };
}

// ---- The 5-minute hook ---------------------------------------------------------------------------
export async function sweepPlatform(db: DB, origin: string, now = Date.now()) {
  const lifecycle = await sweepLifecycle(db, origin, now).catch(() => 0);
  await sweepAlerts(db, now).catch(() => {});
  const emailed = await emailAlerts(db, origin, now).catch(() => 0);
  const snap = await snapshotMrr(db, now).catch(() => null);
  return { lifecycle, alerts_emailed: emailed, snapshot: snap?.day ?? null };
}
