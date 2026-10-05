import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";

// Test credentials must never become a production fallback, including hosted previews.
export const testAuthEnabled = () => process.env.NODE_ENV !== "production" && !process.env.VERCEL && process.env.DEMO_ENABLED === "1";
export const oneTimeCode = () => String(randomInt(100000, 1000000));
export const AUTH_TEMPLATES = new Set(["signin_code", "verify_contact", "password_reset", "account_reset", "account_welcome", "owner_welcome", "email_verify", "owner_signin_link", "staff_invite"]);
export const sensitiveMessage = (template: unknown) => AUTH_TEMPLATES.has(String(template));
export function redactNotification<T extends Record<string, unknown>>(row: T): T {
  if (!sensitiveMessage(row.template)) return row;
  return { ...row, body: "Authentication message — content hidden", html: "", subject: "Authentication message", error: "", status_note: "Content hidden for account security" };
}
function deliveryKey() {
  const secret = process.env.AUTH_DELIVERY_SECRET || process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (testAuthEnabled()) return createHash("sha256").update("isolated-development-delivery-key").digest();
    throw new Error("Authentication delivery requires a secret of at least 32 characters");
  }
  return createHash("sha256").update(secret).digest();
}
export function sealDelivery(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", deliveryKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `sealed:v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
}
export function openDelivery(value: string): string {
  if (!value.startsWith("sealed:v1:")) return value; // queued pre-migration messages
  const b = Buffer.from(value.slice(10), "base64");
  const decipher = createDecipheriv("aes-256-gcm", deliveryKey(), b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString("utf8");
}
export const escapeHtml = (v: string) => v.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
export function clientIp(headers: { header(k: string): string | undefined }): string {
  // Vercel supplies x-forwarded-for. Never trust a caller's Cloudflare header here.
  return (headers.header("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
export function publicShop<T extends object>(shop: T): T {
  const raw = (shop as { voice_json?: string }).voice_json;
  if (!raw) return shop;
  let voice: Record<string, unknown> = {};
  try { voice = JSON.parse(raw); } catch { /* no readable settings */ }
  const { secret: _secret, webhook_secret: _webhook, ...safe } = voice;
  return { ...shop, voice_json: JSON.stringify(safe) };
}

export function withDatabase<C extends { env: { DB: import("../db/client").Database } }>(context: C, db: import("../db/client").Database): C {
  return new Proxy(context, { get(target, key) {
    if (key === "env") return { ...target.env, DB: db };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

// Push subscriptions are capabilities issued by known browser push services, not arbitrary URLs.
export function isPushEndpoint(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
    return ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(u.hostname)
      || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.notify\.windows\.com$/.test(u.hostname);
  } catch { return false; }
}

// Defence in depth for tenant JSON APIs. Explicit statement/CSV projections remain allowlisted.
export function redactProviderCosts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProviderCosts);
  if (!value || typeof value !== "object") return value;
  const privateKeys = new Set(["stripe_fee_pence", "provider_cost_pence", "provider_fee_pence", "margin_pence"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.has(key)).map(([key, v]) => [key, redactProviderCosts(v)]));
}
