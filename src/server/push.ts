// Web Push to customers' installed shop apps. Each shop's PWA subscribes with the platform VAPID
// key; a subscription is scoped to (account, shop) so a customer who installed two shops' apps
// only hears from each shop in that shop's app.
//
// Env: PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY (generate once: `npx web-push generate-vapid-keys`),
// PUSH_VAPID_SUBJECT (mailto: or https: — who to contact about abuse). Missing keys = push off, the
// rest of messaging is unaffected.
import webpush from "web-push";
import type { Database as DB } from "../db/client";

type Env = Record<string, string | undefined>;
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});

export function pushStatus() {
  const e = env();
  const on = !!(e.PUSH_VAPID_PUBLIC_KEY && e.PUSH_VAPID_PRIVATE_KEY);
  return { enabled: on, public_key: on ? e.PUSH_VAPID_PUBLIC_KEY! : "" };
}
let configured = false;
function ensure() {
  const e = env();
  if (configured || !e.PUSH_VAPID_PUBLIC_KEY || !e.PUSH_VAPID_PRIVATE_KEY) return configured;
  webpush.setVapidDetails(e.PUSH_VAPID_SUBJECT || "https://foliyo.co.uk", e.PUSH_VAPID_PUBLIC_KEY, e.PUSH_VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export type PushSubscriptionRow = { id: string; account_id: string; shop_id: string; endpoint: string; p256dh: string; auth: string; failures: number };
export type PushPayload = { title: string; body: string; url: string; tag?: string; icon?: string; badge?: string };

// Send one payload to every live subscription this account holds for this shop. Expired or gone
// endpoints (404/410) are removed; other failures are counted and the row dropped after five.
export async function pushToAccount(db: DB, shopId: string, accountId: string, payload: PushPayload): Promise<{ sent: number; removed: number }> {
  if (!ensure()) return { sent: 0, removed: 0 };
  const subs = await db.prepare("SELECT * FROM customer_push_subscriptions WHERE shop_id=? AND account_id=?").bind(shopId, accountId).all<PushSubscriptionRow>();
  let sent = 0, removed = 0;
  const now = Date.now();
  for (const s of subs.results) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 24 * 3600, urgency: "high" });
      sent++;
      await db.prepare("UPDATE customer_push_subscriptions SET last_used_at=?, failures=0 WHERE id=?").bind(now, s.id).run();
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode ?? 0;
      if (code === 404 || code === 410 || s.failures + 1 >= 5) {
        await db.prepare("DELETE FROM customer_push_subscriptions WHERE id=?").bind(s.id).run();
        removed++;
      } else {
        await db.prepare("UPDATE customer_push_subscriptions SET failures=failures+1 WHERE id=?").bind(s.id).run();
      }
    }
  }
  return { sent, removed };
}

// Find the customer account behind a booking's phone so a booking-level event can notify the app.
export async function accountForPhone(db: DB, phone: string): Promise<string | null> {
  const row = await db.prepare("SELECT id FROM customer_accounts WHERE phone=?").bind(phone).first<{ id: string }>();
  return row?.id ?? null;
}
