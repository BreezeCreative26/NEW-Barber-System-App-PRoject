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

## Where things are

| Path | What |
| --- | --- |
| `/workspace` | Staff app: calendar, customers, insights, wallet, team, services, settings |
| `/<slug>` · `/book/<slug>` | Shop home page with embedded booking · booking-only page |
| `/<slug>/me` · `/manage/<token>` · `/offer/<token>` | Customer account · manage a visit · waiting-list offer |
| `/api/sandbox/*` | Staff API (session cookie) — name is historical, rename pending |
| `/api/public/*` | Customer API (same-origin guard) |
| `/robots.txt` · `/sitemap.xml` · `/media/<id>` | Search engines · uploaded photos |

## Layout

`app/` Next route handler → `src/index.tsx` Hono app → `src/server/*` routers and domain rules ·
`src/db/` schema, client, storage · `src/client/` React app · `tests/` Playwright + vitest ·
`scripts/` db apply/seed/smoke.
