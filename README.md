# OLLO — barbershop booking and shop management

Online booking, a live calendar for the shop, customers, waiting list, reviews, payments ledger and
staff pay — built to run many shops on one deployment. Read **`DIRECTION.md`** first: it holds the
platform decision, the (short) working rules and the build order. `docs/PROGRESS.md` is the
running log; `docs/*-PLAN.md` are the feature plans.

## Stack

Next.js 15 (App Router, Node runtime) hosting a **Hono** API · React 19 client (Vite-built into
`public/static`) · **Postgres on Supabase** via the `postgres` driver (`src/db/client.ts`) ·
Supabase Storage for photos · Vercel for deploys and cron.

## Run it

```bash
cp .env.example .env          # fill in DATABASE_URL (pooler :6543), DIRECT_URL (:5432), Supabase URL + service key
npm install
npm run db:schema             # applies src/db/schema.sql (add -- --force to drop and recreate)
npm run build && npm run start
node scripts/db-seed.mjs      # builds Northline Barbers (the demo shop): owner@demo.test / Demo1234!
node scripts/smoke.mjs        # 29 end-to-end checks against the running server
```

Local dev without Supabase: run Postgres locally and point `DATABASE_URL`/`DIRECT_URL` at it in
`.env.local`; photos fall back to `.media/` on disk.

## Schema changes

`src/db/schema.sql` is the full schema for a fresh database. Changes to an existing database go in
`src/db/migrations/NNNN_name.sql` and are applied with `npm run db:migrate` (tracks applied files in
`ollo_migrations`). Run it against Supabase after pulling a migration, before or right after deploy.

## Deploy (Vercel)

1. Import this repo in Vercel (framework: Next.js, defaults otherwise; `vercel.json` sets `lhr1`).
2. Environment variables: `DATABASE_URL`, `DIRECT_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET` (long random string), optionally
   `ALLOWED_ORIGINS` (comma-separated extra origins for the same-origin guard).
3. Push to `main` → production. Branches → preview URLs.
4. Leave `DEMO_ENABLED` unset (or `0`) in production — it exposes the demo sign-in and the dev mailbox.
5. **Check `/api/diag?ping=1` after every deploy.** It reports the Node version, region, commit,
   any missing required env vars, the database host and a live `SELECT 1` — a deploy that "builds
   fine but every page is a blank 500" is almost always an empty env var, and this tells you which.
6. Run `npm run db:migrate` against Supabase whenever `src/db/migrations/` gains a file; the app does
   not migrate on boot.

Production: https://new-barber-system-app-p-roject.vercel.app

## Payments (Stripe Connect platform)

OLLO is the merchant of record. Card money — online deposits now, Terminal later — lands on OLLO's
Stripe balance; **approving a pay run transfers each barber's share to their own Stripe Express
account and the shop's share to the shop's**, tagged per run. Cash never enters and shows as a
residual to settle by hand. Refunds, voids and disputes create reversals, never edits.

| Env var | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | platform key (`sk_test_…` / `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | `POST /api/stripe/webhook` (tick *Connected accounts* too) |
| `STRIPE_CONNECT` | defaults on; `0` for a single-shop deploy |

**Card at the chair:** Checkout → *Take by card* → a QR / pay link the customer scans (no hardware),
or a paired Stripe reader (WisePOS / Tap to Pay). Both land in the ledger as platform card money.

Without keys the app runs in **preview mode**: deposits payable in the shop, pay runs settled by
hand, every Settings → Payments control visible but honest about why it's off. Full runbook,
tiers (STANDARD / FAST float), auto pay runs and the test-mode checklist: **`docs/PAYMENTS.md`**.

## Front door and sign-up

`/` is a server-rendered marketing page (no JS, indexable, JSON-LD) with five "Create your shop"
CTAs → `/signup`. Visitors with an `ollo_session` cookie are sent straight to `/workspace`. A new
owner lands on an empty calendar with a **"Get {shop} live"** checklist (services → hours/team →
booking link) that ticks itself off and disappears once the shop is bookable. Copy lives in
`src/server/landing.ts`, styles in `public/static/landing.css`, hero in `public/static/landing/`.

## Operations

- **Errors**: `src/server/telemetry.ts` posts unexpected server errors and browser errors
  (`POST /api/telemetry/error`, from the React boundary / `window.onerror`) to Sentry's envelope
  endpoint when `SENTRY_DSN` is set; otherwise they go to the server log. No SDK, no request bodies
  or cookies in payloads. `/api/health` and `/api/diag` show which sink is active.
- **Abuse controls**: sign-up 60/IP/10 min, login 12/email + 60/IP, public GETs 600/IP/10 min
  (in-memory per instance), public writes throttled per shop/phone in the database. Override with
  `SIGNUP_IP_LIMIT`, `LOGIN_IP_LIMIT`, `PUBLIC_READ_LIMIT` (test runners raise them).
- **Retention**: the 5-minute sweep deletes delivered/skipped/failed notifications older than 180
  days; queued rows are never touched.

## Calendar (Fresha-grade) — all four phases shipped

- **Move**: press-and-drag a confirmed card; the top edge is the new start, snapping every 15 min with a
  haptic/CSS tick and a live time label. Sideways = another barber. Greyed cells (outside hours, break,
  blocked, occupied) are still clickable — the shop confirms and books over them (`force`); past time,
  closures and days off never are. Overlapping cards share the column in lanes.
- **Resize**: drag the bottom edge to change the length (15-min snap, live end-time label); saves through
  `PATCH /bookings/:id/items` with the price untouched.
- **Undo**: after a move or resize the green notice offers one-step Undo for 20 s.
- **Edit in place**: appointment panel → *Edit* changes service, add-ons, price and duration; re-pricing
  below a paid deposit refunds the difference, charged against the barber's pay run.
- **Blocked time**: ⋯ beside each barber (or right-click a cell) → *Block time…* with a type and reason.
  Affected customers are listed with their contact channel; choose Move (next free slot suggested),
  Cancel & refund, or Keep, and whether to tell them. Public availability shows blocks only as
  "Unavailable". Barbers may block their own time.
- **Scheduled team**: rostered barbers show by default; the *Scheduled team · n/N* picker adds others for
  the day (kept in `localStorage`).
- **Card icons**: online · walk-in · standing · returning customer · deposit paid · paid.

Full plan, decisions and status: **`docs/CALENDAR_PLAN.md`**.

## Messages (email + SMS)

Every customer message — booking confirmed / moved / cancelled, reminders, sign-in codes,
waiting-list offers, review requests, staff invites — is sent **as the shop** (shop name, logo,
accent). OLLO never appears in a customer's inbox.

| Env var | Purpose |
| --- | --- |
| `RESEND_API_KEY`, `MAIL_FROM` | Email via Resend (`MAIL_FROM` e.g. `bookings@yourdomain.com`, verified in Resend) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` **or** `TWILIO_MESSAGING_SERVICE_SID` | SMS via Twilio |
| `CRON_SECRET` | Protects `GET /api/cron/messages` (Vercel Cron sends it as `Authorization: Bearer …`) |

Without keys the app runs in **preview mode**: messages are written to the outbox with the
`mailbox` provider and nothing leaves. Sign-in codes are shown on screen. Owners see the mode in
**Settings → Messages**, where they can toggle SMS / email / reminders, set reply-to and SMS sender,
send a test, and preview / copy / resend anything in the outbox.

Delivery: `notifications` is the queue (QUEUED → SENDING → SENT / FAILED, backoff 1m · 5m · 30m · 2h
· 12h). A sweep runs lazily at most once per 5 minutes from any `/api` request and on the Vercel Cron
schedule in `vercel.json`; it also queues reminders (configurable hours before + 2 hours before,
once per booking per channel).

## Where things are

| Path | What |
| --- | --- |
| `/workspace` | Staff app: calendar, customers, insights, wallet, team, services, settings |
| `/<slug>` · `/book/<slug>` | Shop home page with embedded booking · booking-only page |
| `/<slug>/me` · `/manage/<token>` · `/offer/<token>` | Customer account · manage a visit · waiting-list offer |
| `/api/app/*` (`/api/sandbox/*` legacy alias) | Staff API (session cookie) |
| `/api/cron/messages` | Sweep: reminders, message queue, deposit holds, scheduled pay runs (Vercel Cron, `CRON_SECRET`) |
| `/api/stripe/webhook` | Stripe events: deposits, chair payments, accounts, transfers, payouts, disputes, refunds |
| `/pay/<id>` | Customer landing after a chair pay link |
| `/api/public/*` | Customer API (same-origin guard) |
| `/robots.txt` · `/sitemap.xml` · `/media/<id>` | Search engines · uploaded photos |

## Layout

`app/` Next route handler → `src/index.tsx` Hono app → `src/server/*` routers and domain rules ·
`src/db/` schema, client, storage · `src/client/` React app · `tests/` Playwright + vitest ·
`scripts/` db apply/seed/smoke.
