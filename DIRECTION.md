# OLLO — direction (read this first)

OLLO is a barbershop SaaS: online booking, a working calendar for the shop, customers, payments,
messages. Many shops will run on one deployment. **Right now we are building one real shop and
getting it right; SaaS signup/plans/billing come after that shop runs a real week.**

## Platform decision (2026-09-16)

Moved from Cloudflare Pages + D1 to **Next.js on Vercel + Postgres on Supabase**. Reasons:
background jobs (reminders, expiries, payouts) need cron; Postgres is the SaaS default (RLS,
backups, tooling, hiring); Vercel matches the team's push-to-deploy habit; the Node ecosystem
(Stripe, Twilio, Resend) fits without workarounds. Cloudflare stays useful later for DNS/CDN and
per-shop custom domains ("Cloudflare for SaaS"), not as the app runtime.

Stack: Next.js 15 (App Router) · Hono API mounted at `/api/*` · Drizzle + `postgres` driver ·
Supabase Postgres (transaction pooler at runtime, session pooler for migrations) · Supabase
Storage for photos · Vercel Cron for sweeps · Stripe / Twilio / Resend when we wire money and
messages. One database; every business row carries `shop_id`.

## How we work now (the only rules)

1. **Push to deploy.** `main` → Vercel production. Branches get preview URLs. Test on the URL.
2. **Per change:** `npm run typecheck && npm run build` must pass. Run the tests that touch what
   you changed. The full suite runs before a release tag, not every commit.
3. **Correctness where money or bookings are involved** stays in the database (constraints,
   transactions) and in tests. UI journeys get tests only when they've broken twice.
4. **No ceremony:** no design guardrail scripts, no contract lists, no screenshot handoffs, no
   per-slice doc rewrites. Update `PROGRESS.md` with a few lines when something meaningful ships.
5. **Secrets** live in `.env` (git-ignored) locally and in Vercel project settings in production.
   Never in code, never in chat if avoidable. Rotate anything that has been pasted anywhere.
6. **Design system** stays: tokens in `design.css`, Lucide icons via `<Icon>`. Don't add a second
   styling system. That's it.

## Build order

1. Platform move (this repo): schema on Postgres, server ported, client mounted in Next, demo shop
   seeded, deployed. Sandbox mode, "Local test data" banners and "no payment taken" copy removed.
2. Real messages: Twilio SMS + Resend email behind the existing outbox (SKIPPED → SENT). Booking
   confirmations, reminders (cron), waitlist offers, review requests.
3. Real payments: Stripe — deposit at booking, card at checkout, refunds.
4. Run the one shop for real; fix what the owner hits in week one.
5. SaaS: shop signup, plans + Stripe Billing, per-shop custom domains, owner onboarding.

## Repo map

- `app/` Next.js routes (`/workspace`, `/[slug]`, `/[slug]/me`, `/book/[slug]`, `/manage/[token]`,
  `/offer/[token]`, `/api/[[...route]]` → Hono).
- `src/server/` Hono routers and domain rules (ported from the Cloudflare version).
- `src/db/` Drizzle schema, migrations, client.
- `src/client/` React app (Workspace, ShopPage, PublicBooking, CustomerArea, …).
- `docs/` plans (`CUSTOMER-PLAN.md`, `WAITLIST-PLAN.md`, `SHOP-PAGE-PLAN.md`) and `PROGRESS.md`.
