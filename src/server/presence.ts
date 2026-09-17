// Shop page phase 2: verified reviews, uploaded photos (R2) and the search-engine head.
// See docs/SHOP-PAGE-PLAN.md. Everything here is presentation + moderation; bookings are untouched.
import type { Context } from "hono";
import { z } from "zod";
import type { Database as D1Database } from "../db/client";
import type { ObjectStore as R2Bucket } from "../db/storage";
import type { Shop, ShopPage, StoredBooking } from "./domain";
import { defaultShopPage, parseTheme, shopDay } from "./domain";
import type { AppEnv } from "./accounts";

export type MediaEnv = AppEnv & { Bindings: AppEnv["Bindings"] & { MEDIA?: R2Bucket } };
type Ctx = Context<AppEnv>;
const uid = () => crypto.randomUUID();

// ---- Reviews ------------------------------------------------------------------------
export type ReviewRow = {
  id: string;
  shop_id: string;
  booking_id: string;
  customer_id: string | null;
  staff_id: string;
  service_name: string;
  rating: number;
  body: string;
  display_name: string;
  status: "PUBLISHED" | "HIDDEN";
  reply: string;
  reply_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
};
export const REVIEW_WINDOW_MS = 60 * 86400000;
export const reviewSchema = z.object({ rating: z.coerce.number().int().min(1).max(5), body: z.string().trim().max(600).default("") }).strict();
export const replySchema = z.object({ reply: z.string().trim().max(400), version: z.number().int().nonnegative() }).strict();
export const reviewStatusSchema = z.object({ status: z.enum(["PUBLISHED", "HIDDEN"]), version: z.number().int().nonnegative() }).strict();

// "Amira K." — never the full name, never the phone.
export const displayName = (full: string) => {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "A customer";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
};

// Can this booking be reviewed right now? Returns a reason when not.
export function reviewEligibility(b: StoredBooking, existing: ReviewRow | null, now = Date.now()): { ok: true } | { ok: false; reason: "already_reviewed" | "not_completed" | "window_closed" } {
  if (existing) return { ok: false, reason: "already_reviewed" };
  if (b.status !== "COMPLETED") return { ok: false, reason: "not_completed" };
  if (now - b.end_at > REVIEW_WINDOW_MS) return { ok: false, reason: "window_closed" };
  return { ok: true };
}

export async function reviewForBooking(db: D1Database, bookingId: string) {
  return db.prepare("SELECT * FROM reviews WHERE booking_id=?").bind(bookingId).first<ReviewRow>();
}

// Write a review for a completed booking. Caller has already authenticated the customer.
export async function leaveReview(c: Ctx, shop: Shop, b: StoredBooking, input: z.infer<typeof reviewSchema>, actor: string, now = Date.now()): Promise<{ error: string; review: ReviewRow | null } | { error?: undefined; review: ReviewRow }> {
  const existing = await reviewForBooking(c.env.DB, b.id);
  const ok = reviewEligibility(b, existing, now);
  if (!ok.ok) return { error: ok.reason, review: existing };
  const id = uid();
  const who = displayName(b.attendee_name || b.customer_name);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO reviews(id,shop_id,booking_id,customer_id,staff_id,service_name,rating,body,display_name,status,reply,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'PUBLISHED','',0,?,?)",
    ).bind(id, shop.id, b.id, b.customer_id ?? null, b.staff_id, b.service_name, input.rating, input.body, who, now, now),
    c.env.DB.prepare("INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(
      uid(),
      shop.id,
      "review",
      id,
      "REVIEW_LEFT",
      actor,
      `${input.rating}/5 for ${b.service_name} on ${b.date}${input.body ? " with a comment" : ""}.`,
      now,
    ),
  ]);
  return { review: (await reviewForBooking(c.env.DB, b.id))! };
}

// Customer's own view of a review (on the manage page / in /me).
export const ownReviewView = (r: ReviewRow | null) => (r ? { id: r.id, rating: r.rating, body: r.body, status: r.status, reply: r.reply, created_at: r.created_at } : null);

// Public summary + newest published reviews for the shop page and JSON-LD.
export async function publicReviews(db: D1Database, shopId: string, limit = 12) {
  const [agg, rows] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE shop_id=? AND status='PUBLISHED'").bind(shopId),
    db.prepare(
      "SELECT r.id,r.rating,r.body,r.display_name,r.reply,r.reply_at,r.created_at,r.service_name,s.name AS staff_name FROM reviews r LEFT JOIN staff s ON s.shop_id=r.shop_id AND s.id=r.staff_id WHERE r.shop_id=? AND r.status='PUBLISHED' ORDER BY r.created_at DESC LIMIT ?",
    ).bind(shopId, limit),
  ]);
  const a = (agg.results[0] as { n: number; avg: number | null }) ?? { n: 0, avg: null };
  return {
    summary: { count: a.n, average: a.n ? Math.round((a.avg ?? 0) * 10) / 10 : null },
    reviews: rows.results as { id: string; rating: number; body: string; display_name: string; reply: string; reply_at: number | null; created_at: number; service_name: string; staff_name: string | null }[],
  };
}

// ---- Media (R2) -----------------------------------------------------------------------
export type MediaRow = { id: string; shop_id: string; kind: "cover" | "gallery" | "staff" | "logo"; object_key: string; content_type: string; bytes: number; width: number | null; height: number | null; alt: string; uploaded_by: string; created_at: number };
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const mediaKinds = ["cover", "gallery", "staff", "logo"] as const;

// Sniff the real type from the first bytes; the filename and declared type are not trusted.
export function sniffImage(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}
// Cheap dimensions for PNG/JPEG (WebP left null); used for width/height hints only.
export function imageSize(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png" && bytes.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}
export const mediaUrl = (id: string) => `/media/${id}`;

// Everything that may reference an uploaded image; used to scrub on delete.
export async function scrubMediaReferences(db: D1Database, shopId: string, url: string, now: number) {
  const page = await db.prepare("SELECT cover_url,logo_url,gallery_json FROM shop_pages WHERE shop_id=?").bind(shopId).first<{ cover_url: string; logo_url: string; gallery_json: string }>();
  const statements = [db.prepare("UPDATE staff SET photo_url='' WHERE shop_id=? AND photo_url=?").bind(shopId, url)];
  if (page) {
    const gallery = (JSON.parse(page.gallery_json || "[]") as string[]).filter((u) => u !== url);
    statements.push(
      db.prepare("UPDATE shop_pages SET cover_url=CASE WHEN cover_url=? THEN '' ELSE cover_url END, logo_url=CASE WHEN logo_url=? THEN '' ELSE logo_url END, gallery_json=?, updated_at=? WHERE shop_id=?").bind(url, url, JSON.stringify(gallery), now, shopId),
    );
  }
  await db.batch(statements);
}

// ---- SEO head ---------------------------------------------------------------------------
const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const townOf = (address: string) => {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  // "12 Market Row, London E8 4QJ" → "London"; drop a trailing postcode token.
  return parts[parts.length - 1].replace(/\s+[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i, "").trim();
};

export type HeadInput = {
  origin: string;
  shop: Shop;
  page: ShopPage;
  week: { weekday: number; open: boolean; starts?: number; ends?: number }[];
  services: { name: string; price_pence: number; description?: string; duration_min: number }[];
  staff: { name: string; title?: string; photo_url?: string }[];
  rating: { count: number; average: number | null };
};

export function shopPageHead(i: HeadInput) {
  const url = `${i.origin}/${i.shop.slug}`;
  const town = townOf(i.shop.address);
  const title = `${i.shop.name} · ${town ? `Barbers in ${town}` : "Book online"}`;
  const description = (i.page.strapline || i.page.about || `${i.shop.name}${i.shop.address ? `, ${i.shop.address}` : ""}. Book your next visit online.`).slice(0, 160);
  const abs = (u: string) => (u.startsWith("/") ? i.origin + u : u);
  const image = abs(i.page.cover_url || i.page.logo_url || "/static/brand/og-default.svg");
  const prices = i.services.map((s) => s.price_pence).filter((p) => p > 0);
  const fmt = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: i.shop.currency || "GBP", maximumFractionDigits: 0 }).format(n);
  const priceRange = prices.length ? `${fmt(Math.floor(Math.min(...prices) / 100))}–${fmt(Math.ceil(Math.max(...prices) / 100))}` : undefined;
  const hours = i.week.filter((d) => d.open && d.starts !== undefined && d.ends !== undefined).map((d) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: DAY_NAMES[d.weekday], opens: hhmm(d.starts!), closes: hhmm(d.ends!) }));
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "HairSalon",
    "@id": `${url}#shop`,
    name: i.shop.name,
    url,
    image,
    ...(i.page.phone ? { telephone: i.page.phone } : {}),
    ...(i.page.email ? { email: i.page.email } : {}),
    ...(i.shop.address ? { address: { "@type": "PostalAddress", streetAddress: i.shop.address.split(",")[0].trim(), ...(town ? { addressLocality: town } : {}), addressCountry: "GB" } } : {}),
    ...(priceRange ? { priceRange } : {}),
    ...(hours.length ? { openingHoursSpecification: hours } : {}),
    ...(i.page.instagram ? { sameAs: [`https://instagram.com/${i.page.instagram}`] } : {}),
    ...(i.rating.count > 0 && i.rating.average !== null ? { aggregateRating: { "@type": "AggregateRating", ratingValue: i.rating.average, reviewCount: i.rating.count, bestRating: 5, worstRating: 1 } } : {}),
    ...(i.services.length
      ? {
          hasOfferCatalog: {
            "@type": "OfferCatalog",
            name: "Services",
            itemListElement: i.services.slice(0, 40).map((s) => ({
              "@type": "Offer",
              itemOffered: { "@type": "Service", name: s.name, ...(s.description ? { description: s.description } : {}) },
              price: (s.price_pence / 100).toFixed(2),
              priceCurrency: i.shop.currency || "GBP",
            })),
          },
        }
      : {}),
    ...(i.staff.length ? { employee: i.staff.slice(0, 20).map((s) => ({ "@type": "Person", name: s.name, ...(s.title ? { jobTitle: s.title } : {}), ...(s.photo_url ? { image: abs(s.photo_url) } : {}) })) } : {}),
    potentialAction: { "@type": "ReserveAction", target: { "@type": "EntryPoint", urlTemplate: `${url}#book`, actionPlatform: ["https://schema.org/DesktopWebPlatform", "https://schema.org/MobileWebPlatform"] }, result: { "@type": "Reservation", name: "Book a visit" } },
  };
  // JSON inside <script> must not be able to close the tag.
  const ldJson = JSON.stringify(ld).replace(/</g, "\\u003c");
  // First paint matters: preload the hero image and the theme's typefaces so nothing swaps in late.
  const theme = parseTheme(i.page.theme_json);
  const fontFiles: Record<string, string[]> = {
    modern: [],
    editorial: ["fraunces-latin-opsz-normal", "manrope-latin-wght-normal"],
    grotesk: ["space-grotesk-latin-wght-normal"],
    heritage: ["playfair-display-latin-wght-normal", "dm-sans-latin-opsz-normal"],
    condensed: ["bebas-neue-latin-400-normal", "dm-sans-latin-opsz-normal"],
    soft: ["dm-sans-latin-opsz-normal"],
  };
  const preloads = [
    ...(i.page.cover_url ? [`<link rel="preload" as="image" href="${esc(i.page.cover_url)}" fetchpriority="high"/>`] : []),
    ...(fontFiles[theme.font] || []).map((f) => `<link rel="preload" as="font" type="font/woff2" href="/static/fonts/${f}.woff2" crossorigin/>`),
    `<link rel="stylesheet" href="/static/theme-fonts.css"/>`,
    `<meta name="theme-color" content="${theme.mode === "dark" ? "#0f1117" : "#ffffff"}"/>`,
  ];
  const tags = [
    ...preloads,
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}"/>`,
    `<meta name="robots" content="${i.page.published ? "index,follow" : "noindex,nofollow"}"/>`,
    `<link rel="canonical" href="${esc(url)}"/>`,
    `<meta property="og:type" content="business.business"/>`,
    `<meta property="og:site_name" content="${esc(i.shop.name)}"/>`,
    `<meta property="og:title" content="${esc(title)}"/>`,
    `<meta property="og:description" content="${esc(description)}"/>`,
    `<meta property="og:url" content="${esc(url)}"/>`,
    `<meta property="og:image" content="${esc(image)}"/>`,
    `<meta property="og:locale" content="en_GB"/>`,
    `<meta name="twitter:card" content="summary_large_image"/>`,
    `<meta name="twitter:title" content="${esc(title)}"/>`,
    `<meta name="twitter:description" content="${esc(description)}"/>`,
    `<meta name="twitter:image" content="${esc(image)}"/>`,
    `<script type="application/ld+json">${ldJson}</script>`,
  ];
  return { title, description, image, html: tags.join("") };
}

// Load what the head needs in one place so index.tsx stays small.
export async function headData(db: D1Database, shop: Shop) {
  const [page, staff, services, hours] = await Promise.all([
    db.prepare("SELECT * FROM shop_pages WHERE shop_id=?").bind(shop.id).first<ShopPage>(),
    db.prepare("SELECT name,title,photo_url FROM staff WHERE shop_id=? AND active=1 AND online_visible=1 ORDER BY sort_order,name").bind(shop.id).all<{ name: string; title: string; photo_url: string }>(),
    db.prepare("SELECT name,price_pence,description,duration_min FROM services WHERE shop_id=? AND active=1 AND online_bookable=1 ORDER BY popular DESC,sort_order,category,name").bind(shop.id).all<{ name: string; price_pence: number; description: string; duration_min: number }>(),
    db.prepare("SELECT weekday,enabled,starts,ends FROM staff_hours WHERE shop_id=?").bind(shop.id).all<{ weekday: number; enabled: number; starts: number; ends: number }>(),
  ]);
  const week = Array.from({ length: 7 }, (_, wd) => {
    const day = shopDay(shop, wd);
    const on = hours.results.filter((h) => h.weekday === wd && h.enabled);
    if (!day.enabled || !on.length) return { weekday: wd, open: false };
    return { weekday: wd, open: true, starts: Math.max(day.starts, Math.min(...on.map((h) => h.starts))), ends: Math.min(day.ends, Math.max(...on.map((h) => h.ends))) };
  });
  const { summary } = await publicReviews(db, shop.id, 1);
  return { page: page ?? defaultShopPage(shop.id), staff: staff.results, services: services.results, week, rating: summary };
}
