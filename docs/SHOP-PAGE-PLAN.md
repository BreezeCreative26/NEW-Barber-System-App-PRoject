# Shop page, phase 2 — search, reviews, photos

The home page at `/<slug>` (see PROGRESS "public shop home page") had three gaps: search engines
could not read it, there was no social proof, and photos were https-URL-only so the demo had none.
This slice closes them without changing how booking works.

## 1. Search (SEO)

- **Server-rendered head.** `/<slug>` is still the SPA, but the worker now writes the head from
  the database: `<title>{Shop} · Barbers in {town}</title>` (town = last comma part of the
  address), meta description (strapline → about → address), `<link rel=canonical>`, Open Graph
  (`og:type business.business`, title, description, url, image = cover or the OLLO default card),
  Twitter summary card, and JSON-LD `HairSalon` (name, url, telephone, address, image,
  `openingHoursSpecification` from the shop's weekly hours, `priceRange` from the catalogue,
  `aggregateRating` when there are published reviews, `hasOfferCatalog` listing bookable services
  with prices). Nothing in the JSON-LD is invented: every field comes from a row the owner edits.
- **Robots.** Published shop pages are `index,follow`. Everything else stays `noindex`: `/book/*`,
  `/manage/*`, `/offer/*`, `/<slug>/me`, `/workspace`, and hidden pages. `/robots.txt` allows `/`
  and disallows `/api/`, `/workspace`, `/manage/`, `/offer/`, `/*/me`; it points at
  `/sitemap.xml`, which lists every online **and published** shop with `lastmod` from the page's
  last edit.
- **Hidden means hidden.** `published = 0` now returns 404 from `/<slug>` and from
  `GET /api/public/shops/:slug/page`. `/book/<slug>` keeps working (the Settings copy already said
  so). Owners untick Published to hide, tick to go live; the panel says what happens.

## 2. Reviews

- **Who can review.** The person who had the visit, once per booking, after the booking is
  `COMPLETED`, within 60 days. Two doors, same rule: the manage link (`/manage/<token>` shows
  "How was it?" once the visit is completed) and the signed-in area (`/<slug>/me` history rows).
  Rating 1–5 plus up to 600 characters (text optional). Reviews are **verified by construction** —
  there is no anonymous form.
- **Asking for it.** When staff mark a visit COMPLETED (status change or checkout) a
  `review_request` message is queued to the outbox with the manage link — same outbox and
  templates as the waiting list (`Settings → Messages & waiting list`). Not sent (no provider).
- **What is shown.** Public page: a rating line in the hero (`4.8 ★ · 37 reviews`, only when there
  is at least one published review) and a **Reviews** section (newest 12; first name + initial,
  barber, service, month, stars, text, owner reply). Section toggle `reviews` in the page editor,
  on by default.
- **Owner moderation (Settings → Reviews).** Every review with status; **Hide** / **Show** (hidden
  reviews are kept, never deleted; the customer's copy on their manage page says "not shown on the
  shop page"); **Reply** (one reply, editable, ≤ 400 chars, shown publicly under the review).
  Audit: `REVIEW_LEFT` (actor customer), `REVIEW_HIDDEN`, `REVIEW_SHOWN`, `REVIEW_REPLIED`.
  Barbers can read reviews about their own visits; only OWNER/MANAGER moderate or reply.
- **Data.** `reviews` (id, shop_id, booking_id UNIQUE, customer_id, staff_id, service_name,
  rating, body, display_name, status PUBLISHED|HIDDEN, reply, reply_at, version, created_at,
  updated_at). Demo seed adds ~14 reviews on past completed visits, two with replies, one hidden.

## 3. Photos (R2)

- **Storage.** R2 bucket binding `MEDIA` (local: wrangler's built-in local R2, no account
  needed). `shop_media` row per object: id, shop_id, kind (cover|gallery|staff), key, content
  type, bytes, alt, uploaded_by, created_at. Served at `GET /media/<id>` with immutable caching
  (ids are unique per upload), same origin, so the CSP stays `img-src 'self' data: https:`.
- **Upload.** `POST /api/sandbox/media` (multipart `file`, `kind`, optional `alt`) — OWNER/MANAGER,
  ≤ 5 MB, JPEG/PNG/WebP only, checked by magic bytes not by filename. `GET /api/sandbox/media`
  lists the shop's library; `DELETE /api/sandbox/media/:id` removes the object and scrubs any
  cover, gallery or barber photo that pointed at it. Audit `MEDIA_UPLOADED` / `MEDIA_DELETED`.
- **Where it plugs in.** Same fields as before (`shop_pages.cover_url`, `gallery_json`,
  `staff.photo_url`) now accept **either** an https URL **or** a same-origin `/media/<id>` (or
  `/static/...`) path. The Shop page editor gets an **Upload** button next to Cover and Gallery,
  and the barber editor gets one for the photo, with a URL field kept as the fallback. The
  gallery keeps its 12-image cap; uploads land at the end.
- **Demo.** The demo shop ships with a cover, four gallery photos and three barber portraits from
  `public/static/demo/` (Creative-Commons photos, resized), so the page looks finished out of the
  box and the rebuild is deterministic.

## Not in this slice

Live sending of review requests (provider), Google Business Profile sync, review invitations by
email, image cropping/focal point, per-service photos.
