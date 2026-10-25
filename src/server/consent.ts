// Marketing consent: one rule, used everywhere.
//
//   * A customer is marketed to only if they have not opted out (announce_unsub_at is empty) AND, if they
//     have an app account, they ticked "offers and news" (marketing_opt_in = 1).
//   * Only the customer's own action can switch marketing ON again: ticking the box at sign-up or in their
//     profile. Staff ticks, CSV imports and re-uploads can never override an opt-out.
//   * Anything that says "no" (profile untick, unsubscribe link, STOP reply, staff untick) sets
//     announce_unsub_at, which every audience and every send re-checks.
//   * Every change is written to marketing_consent_log as proof.
import type { Database as DB } from "../db/client";

export type ConsentSource = "app_signup" | "app_profile" | "email_link" | "sms_stop" | "staff";

// SQL fragment: customer `c` must NOT be sent marketing.
export const HELD_BACK_SQL =
  "(c.announce_unsub_at IS NOT NULL OR c.contact_pref='NONE' OR (c.marketing_opt_in=0 AND EXISTS (SELECT 1 FROM customer_account_links l WHERE l.shop_id=c.shop_id AND l.customer_id=c.id)))";

const log = (db: DB, shopId: string, customerId: string, choice: "IN" | "OUT", source: ConsentSource, now: number) =>
  db.prepare("INSERT INTO marketing_consent_log(id,shop_id,customer_id,choice,source,at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), shopId, customerId, choice, source, now).run();

/** Record a customer's marketing choice. `optIn` true only ever comes from the customer themselves. */
export async function setMarketingChoice(db: DB, shopId: string, customerId: string, optIn: boolean, source: ConsentSource, now = Date.now()) {
  const cur = await db.prepare("SELECT marketing_opt_in, announce_unsub_at FROM customers WHERE shop_id=? AND id=?").bind(shopId, customerId).first<{ marketing_opt_in: number; announce_unsub_at: number | null }>();
  if (!cur) return;
  if (optIn) await db.prepare("UPDATE customers SET marketing_opt_in=1, announce_unsub_at=NULL WHERE shop_id=? AND id=?").bind(shopId, customerId).run();
  else await db.prepare("UPDATE customers SET marketing_opt_in=0, announce_unsub_at=COALESCE(announce_unsub_at,?) WHERE shop_id=? AND id=?").bind(now, shopId, customerId).run();
  // Log whenever the recorded choice changes, judged by the log itself so a customer's own "yes" is always
  // on record even if the box was already set (for example by an older import).
  const last = await db.prepare("SELECT choice FROM marketing_consent_log WHERE shop_id=? AND customer_id=? ORDER BY at DESC, id DESC LIMIT 1").bind(shopId, customerId).first<{ choice: string }>();
  const choice = optIn ? "IN" : "OUT";
  // An unsubscribe / STOP / staff "no" is always recorded. A plain un-ticked box at sign-up is not news.
  const explicitNo = source === "email_link" || source === "sms_stop" || source === "staff" || last?.choice === "IN" || cur.marketing_opt_in === 1;
  if (last?.choice !== choice && (optIn || explicitNo)) await log(db, shopId, customerId, choice, source, now);
}

/** A texted STOP stops every marketing message to that number, on every channel, in every shop. */
export async function suppressPhone(db: DB, phoneDigits: string, now = Date.now()) {
  const national = phoneDigits.startsWith("44") ? `0${phoneDigits.slice(2)}` : phoneDigits;
  const match = "regexp_replace(c.phone,'\\D','','g') IN (?,?)";
  await db.prepare(`INSERT INTO marketing_consent_log(id,shop_id,customer_id,choice,source,at) SELECT gen_random_uuid()::text, c.shop_id, c.id, 'OUT', 'sms_stop', ? FROM customers c WHERE ${match} AND c.announce_unsub_at IS NULL`).bind(now, phoneDigits, national).run();
  await db.prepare(`UPDATE customers c SET marketing_opt_in=0, announce_unsub_at=? WHERE ${match} AND c.announce_unsub_at IS NULL`).bind(now, phoneDigits, national).run();
  await db.prepare("UPDATE shop_campaign_contacts SET unsub_at=? WHERE unsub_at IS NULL AND regexp_replace(phone,'\\D','','g') IN (?,?)").bind(now, phoneDigits, national).run();
  await db.prepare("UPDATE marketing_contacts SET unsubscribed_at=?, unsub_reason='Replied STOP' WHERE unsubscribed_at IS NULL AND regexp_replace(phone,'\\D','','g') IN (?,?)").bind(now, phoneDigits, national).run();
}

/** Re-checked at the moment a queued announcement is about to go out. */
export async function announcementSuppressed(db: DB, shopId: string, contactId: string): Promise<boolean> {
  const hit = await db.prepare(`SELECT 1 AS x FROM customers c WHERE c.shop_id=? AND c.id=? AND ${HELD_BACK_SQL}
    UNION ALL SELECT 1 FROM shop_campaign_contacts WHERE shop_id=? AND id=? AND unsub_at IS NOT NULL LIMIT 1`).bind(shopId, contactId, shopId, contactId).first();
  return !!hit;
}
