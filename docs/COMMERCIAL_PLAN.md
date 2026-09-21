# OLLO — Commercial Build Plan: Scheduling Conflicts, Billing, Master Admin, Staff Photos

Status: **approved for build** (owner instruction: "plan this in comprehensive commercial detail", standing auto-approve).
Author: engineering. Date: 2026-09-21. Baseline commit: `43617e7`.

This plan is grounded in the code as it stands. Every section lists what exists, what is missing, the
data model, the API, the UI, the edge cases, and the acceptance tests. Workstreams are ordered so each
ships independently and nothing blocks on a third party except where marked **(needs key)**.

---

## 0. Fixed today (already live)

| Issue | Root cause | Fix | Commit |
|---|---|---|---|
| "Edit hours doesn't work" | Weekly-hours dialog rows used a `<fieldset><legend>` inside a 110px/1fr grid; the browser's legend float pushed the time inputs into the 110px column, so each `<input type="time">` rendered **46px wide** — unusable. Saves actually succeeded; the control was the problem. | Explicit CSS grid for `.weekly-hours-row`, day name as a heading, time inputs full width (227px), `--ctl-h` height. Verified by measurement + screenshot. | `43617e7` |

---

## 1. Scheduling: dated shifts, conflict detection and resolution

### 1.1 What exists
- `staff_hours` (weekly pattern), `staff_schedule_overrides` (dated hours), `staff_days_off`, `staff_blocks`, `holidays`.
- Workspace computes `issues[]` on every read: future bookings that no longer fit (`slotReason` + rules) → shown as a warning banner and in the notifications drawer, each with "Review appointment". **Detection is passive and after the fact** — the owner has to notice the bell.
- Team → Schedule tab: weekly strip, "Edit weekly hours", "Days off (n)", "Dated hours (n)".
- Calendar column menu: "Edit today's hours", "Block time…", "Day off", "Add walk-in".

### 1.2 Gaps
1. No **pre-save conflict preview**: closing a day / changing hours / adding a block / booking a day off saves first and flags later.
2. No **per-appointment resolution choices** at the moment of the change.
3. No **Shifts page**: a per-date roster (who is in, when, breaks, leave, blocks) across the whole team.
4. Conflicts are recomputed on every workspace read (fine) but never **persisted**, so there is no history of "what did we do with them".

### 1.3 Design

#### 1.3.1 Conflict preview API (shared by all four change types)
`POST /api/app/schedule/preview`
```json
{ "kind": "override" | "weekly" | "day_off" | "block" | "holiday",
  "staff_id": "…",                       // omitted for holiday (whole shop)
  "change": { …the same body the save endpoint takes… } }
```
Response:
```json
{ "conflicts": [
    { "booking_id": "…", "ref": "BRB-0132", "customer_name": "…", "phone": "…", "date": "2026-09-22",
      "start_min": 600, "duration_min": 30, "service_name": "…", "price_pence": 2800,
      "reason": "Outside the new hours" | "Falls in the break" | "Day off" | "Blocked time" | "Shop closed",
      "deposit_status": "PAID" | "NONE", "series_id": null,
      "suggestions": [                      // best 3 alternatives, computed with the change applied
        { "date": "2026-09-22", "start_min": 660, "staff_id": "same" },
        { "date": "2026-09-22", "start_min": 600, "staff_id": "<other barber id>", "staff_name": "Marcus" },
        { "date": "2026-09-23", "start_min": 600, "staff_id": "same" } ] } ],
  "summary": { "count": 3, "value_pence": 8400, "deposits_pence": 500 } }
```
Implementation: reuse the existing `issues` computation but with an **in-memory patched schedule** (apply the proposed override/days-off/block to the arrays before calling `slotReason`). Pure function, no writes. Suggestions use `slotReason` over the same patched schedule: same barber same day → other qualified barber same time → same barber next 3 working days.

#### 1.3.2 Conflict dialog (client)
Shown between "Save" and the write whenever `conflicts.length > 0`. Otherwise the save proceeds as now.

```
┌ 3 appointments clash with these hours ─────────────────── £84 booked · £5 in deposits ┐
│ Tue 22 Sep · 10:00 · Ada Lovelace · Signature cut £28              Outside the new hours │
│   ( ) Move to 11:00 with Jay        ( ) Move to 10:00 with Marcus   ( ) Wed 23 · 10:00   │
│   ( ) Keep as booked (override)     ( ) Cancel & notify (refund deposit)                 │
│   ( ) Decide later (flag it)                                                             │
│ … one card per conflict …                                                                │
│ [Apply to all: Move to next free slot ▾]                                                 │
│                                        [Back]  [Save hours and apply 3 decisions]        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
Per-appointment choices (radio):
| Choice | Server action | Customer message |
|---|---|---|
| Move to suggestion | `POST /bookings/:id/reschedule` `{force:false}` with the suggested slot | "moved" template (existing) |
| Keep as booked (override) | none; booking stays, marked `override_reason` in audit | none |
| Cancel & notify | `POST /bookings/:id/status` `{status:"CANCELLED", reason}`; deposit auto-refund via existing `deposit/refund` if `deposit_status=PAID` | "cancelled by shop" template + manage link to rebook |
| Offer to waitlist | Cancel + create `waitlist_entries` row with `source:"SCHEDULE_CHANGE"` | "we'll text you first when a slot frees" |
| Decide later | none; conflict persists in `issues` (current behaviour) | none |

Bulk bar: "Apply to all → Move to next free slot / Keep all / Decide later".

The save is **atomic**: `POST /api/app/schedule/apply` takes `{change, decisions[]}` and runs everything in one `DB.batch()` with version checks; on any 409 nothing is written and the dialog re-opens with fresh data.

#### 1.3.3 Where the dialog appears
- Calendar column menu → Edit today's hours / Day off / Block time…
- Team → Schedule → Edit weekly hours (previews the **next 8 weeks**), Days off, Dated hours
- Settings → General → opening hours / closed days (shop-wide; previews all barbers)
- Holidays (shop closed) — same shop-wide preview
- Drag-resize of a block that now covers a booking

#### 1.3.4 Shifts page (new workspace section, rail icon "clock")
Route `/workspace#shifts`, `SETTINGS`-style tabs: **Day · Week · Leave**.
- **Day**: date picker; one row per active barber: status pill (In / Off / Leave / Holiday), start–end, break, blocks, booked minutes vs available, "Edit" → dated-hours dialog with preview. Footer: total chair hours, utilisation %.
- **Week**: grid barber × day; each cell shows `09:30–18:00` / `Off` / `Leave` / `Dated`. Click a cell → dated-hours dialog. Copy-week and "Apply pattern to next N weeks" actions.
- **Leave**: table of `staff_days_off` + `holidays`, future first, with "Remove" and conflict count. Add leave → preview.
- Conflicts badge on the rail icon = `issues.length`.

#### 1.3.5 Persisted decisions
New table `schedule_change_log(id, shop_id, actor, kind, staff_id, change_json, decisions_json, conflicts_count, created_at)`. Audit already records the underlying booking events; this table gives support a single "what happened when Jay's Tuesday closed" record and feeds the admin panel.

### 1.4 Acceptance tests (Playwright)
1. Close Tuesday for Jay with 2 bookings → dialog lists both with suggestions; choose Move + Cancel → both applied atomically; calendar shows one moved, one cancelled with reason "Hours changed"; audit has `DATED_HOURS_CREATED` + `RESCHEDULED` + `CANCELLED`.
2. Same, but stale version → 409 → dialog reopens, nothing written.
3. Weekly hours change with no future conflicts → no dialog, saves directly (regression).
4. Shop holiday → preview includes all barbers.
5. Shifts week grid renders 7×N cells with correct labels; clicking opens dated-hours prefilled.

Effort: **~4 days** (preview/apply API 1.5, dialog 1, Shifts page 1.5).

---

## 2. Billing: subscriptions, usage, invoices, discounts (OLLO ↔ shop)

This is **OLLO charging shops**, distinct from shops charging customers (already built: Stripe Connect, deposits, pay links, payouts).

### 2.1 What exists
- Pricing on the landing page: **£24.99/mo incl. first barber, +£7.99/extra barber, SMS 6p, WhatsApp 3p, email free, cards 2.2%+20p, AI Concierge £49/mo (300 min, then 12p/min)**. `docs/UNIT_ECONOMICS.md` has margins.
- `platform_payments` (fee_bps, fast_payouts) — the only platform-level config table.
- `notifications` table logs every message with channel + status (SMS/WA/email) → usage source for messaging.
- Voice call log (`voice_json` + calls) → usage source for concierge minutes.
- `staff.active` → seat count.
- Stripe is live in test mode with webhooks (`stripe_events`).
- **No** subscription, invoice, plan, feature-flag or discount tables. Nothing bills a shop today.

### 2.2 Design principles
- **Stripe Billing is the ledger**; OLLO mirrors it. We don't invent invoice numbering or VAT maths.
- **Features are entitlements**, not code branches everywhere: one `entitlements(shop)` function; UI and API both call it.
- **Usage is metered from tables we already write** (notifications, calls, staff) — no new counters to keep in sync.
- **Everything the shop sees is also what admin sees**, from the same tables.

### 2.3 Data model (migration `0019_billing.sql`)
```sql
plans(id TEXT PK, name, monthly_pence, included_seats INT, seat_pence, stripe_price_id, active, sort)
features(key TEXT PK, name, description, kind 'ADDON'|'FLAG', monthly_pence, unit, unit_pence, included_units, stripe_price_id)
  -- seeds: ai_concierge (ADDON £4900, unit 'minute', 12p, 300 incl), sms (unit 6p), whatsapp (unit 3p),
  --        card_payments (FLAG, 0), online_booking (FLAG), waitlist (FLAG), reviews (FLAG), shop_page (FLAG)
shop_subscriptions(shop_id PK, plan_id, status 'TRIAL'|'ACTIVE'|'PAST_DUE'|'PAUSED'|'CANCELLED',
  stripe_customer_id, stripe_subscription_id, seats INT, trial_ends_at, current_period_start, current_period_end,
  cancel_at, billing_email, vat_number, address_json, version)
shop_features(shop_id, feature_key, enabled INT, source 'PLAN'|'ADDON'|'ADMIN_GRANT'|'ADMIN_BLOCK', stripe_item_id,
  granted_by, note, starts_at, ends_at, PK(shop_id, feature_key))
discounts(id PK, code UNIQUE, kind 'PERCENT'|'FIXED'|'FREE_MONTHS'|'SEATS_FREE', value INT, applies_to 'PLAN'|'FEATURE:<key>'|'ALL',
  duration 'ONCE'|'REPEATING'|'FOREVER', duration_months, max_redemptions, redeemed INT, starts_at, ends_at, stripe_coupon_id, created_by, note)
shop_discounts(shop_id, discount_id, applied_at, applied_by, ends_at, PK(shop_id,discount_id))
usage_events(id PK, shop_id, feature_key, quantity INT, unit_pence INT, ref_type 'notification'|'voice_call'|'seat', ref_id,
  occurred_at, period_key 'YYYY-MM', reported_at NULL, stripe_usage_record_id NULL)   -- idempotent on (ref_type, ref_id)
invoices(id PK, shop_id, stripe_invoice_id UNIQUE, number, status 'DRAFT'|'OPEN'|'PAID'|'VOID'|'UNCOLLECTIBLE',
  period_start, period_end, subtotal_pence, discount_pence, tax_pence, total_pence, paid_pence, currency,
  hosted_url, pdf_url, due_at, paid_at, created_at, lines_json)
invoice_adjustments(id PK, invoice_id NULL, shop_id, kind 'CREDIT'|'CHARGE', amount_pence, reason, created_by, created_at, stripe_id)
billing_events(id PK, shop_id, type, payload_json, actor, created_at)   -- human-readable timeline for admin
```

### 2.4 Flows

**Onboarding → trial → active**
1. Shop completes setup → `shop_subscriptions` row `TRIAL`, 14 days, plan `core`, seats = active staff.
2. Settings → **Billing** tab (new, owner-only): plan card, seats, trial countdown, "Add card" → Stripe Checkout (mode=setup) → `stripe_customer_id`; "Start subscription" → Stripe subscription with items: plan price × 1, seat price × (seats − included), plus one item per enabled ADDON, plus metered items for sms/whatsapp/minutes.
3. Webhooks (`customer.subscription.*`, `invoice.*`, `invoice.payment_failed`) mirror into `shop_subscriptions` and `invoices`.

**Automatic amendment when features change** (the owner's key requirement)
- Adding/removing a barber (`staff.active` toggles) → `syncSeats(shop)` updates the seat item quantity **with proration** on the Stripe subscription, writes `billing_events` "Seats 2 → 3 (Marcus Reed added) — +£7.99/mo prorated £3.72 this period", and shows a toast in the app: "Your next invoice changes by +£3.72".
- Turning on the AI Concierge (Messages & AI tab) → `enableFeature(shop,'ai_concierge')` adds the add-on item (prorated) + the metered minutes item; turning off removes at period end (choice: immediately or at period end, default period end). Same for future add-ons.
- Admin grant/block (`ADMIN_GRANT`) → entitlement on, **no Stripe item** (free); appears on the invoice as a £0 line "AI Concierge — complimentary (support)".

**Text tracking with invoices**
- `usage_events` written by `messaging.ts` on every `SENT` notification (6p SMS / 3p WA / 0 email) and by `voice.ts` post-call (minutes, rounded up). Idempotent on `ref_id`.
- Nightly (and on demand) `reportUsage()` pushes unreported events to Stripe usage records for the metered items. Stripe puts them on the invoice automatically.
- Settings → Billing shows **live this-period usage**: "SMS 143 × 6p = £8.58 · WhatsApp 61 × 3p = £1.83 · Concierge 212/300 min included" — read from `usage_events` grouped by `period_key`; the invoice line (from Stripe) appears once issued. Drill-down link to Messages outbox filtered by period.
- Every invoice row: number, period, total, status pill, "View" (hosted URL), "PDF", and an expandable line list; usage lines link to the drill-down.

**Prices, discounts, credits**
- Prices live in `plans` / `features` (mirrored to Stripe Prices by an admin action "Publish price" — creates a new Stripe Price, archives the old, existing subs keep the old price unless "Migrate all" is chosen).
- Discounts: admin creates a code (Stripe Coupon created alongside); applies to a shop (Stripe `discounts` on the subscription) or shop redeems a code in Billing tab. Shown on invoice as Stripe's discount line.
- Credits/one-off charges: admin adds `invoice_adjustments` → Stripe `customer_balance_transaction` (credit) or `invoice_item` (charge) → appears on next invoice.
- Dunning: `PAST_DUE` → banner in the workspace ("Payment failed — update card"), 7 days grace, then `entitlements()` returns read-only (calendar visible, no new bookings, public booking page shows "temporarily unavailable"). Admin can extend grace.

### 2.5 Entitlements function
```ts
entitlements(shop) → { plan, seats, features: Set<key>, readOnly: boolean, reasons: string[] }
```
Sources merged in order: plan defaults → ADDON items → ADMIN_GRANT (on) → ADMIN_BLOCK (off, wins). Cached per request. Used by: server routes (403 `feature_disabled` with a friendly message), workspace payload (`w.entitlements`), UI (locked toggles show "Included in… / Add for £X" instead of hiding).

### 2.6 Shop-facing UI (Settings → Billing, owner only)
Cards: **Plan & seats** · **This period's usage** · **Payment method** · **Invoices** · **Discount code**. Every price shown ex-VAT with "+VAT" per landing copy.

### 2.7 Acceptance tests
- Unit: `entitlements()` merge order; proration maths delegated to Stripe (assert the API call shape).
- Integration (Stripe test clock): trial → active → add barber → seat qty 2, proration line present → 150 SMS → usage record 150 → invoice finalised with 3 lines → mark paid → `invoices.status=PAID`.
- Dunning: `invoice.payment_failed` → `PAST_DUE` banner; after grace, `POST /bookings` → 403 `feature_disabled`.
- Admin grant of `ai_concierge` → toggle enabled in shop with "Complimentary" tag; no Stripe item created.

Effort: **~7 days** (schema+entitlements 1, Stripe Billing integration+webhooks 2.5, usage metering 1, Billing tab 1.5, dunning/edge cases 1). **(needs key)** — a live Stripe secret key with Billing enabled and the webhook secret for `invoice.*` / `customer.subscription.*`.

---

## 3. Master Admin panel (OLLO staff only)

### 3.1 What exists
- Nothing platform-level except `platform_payments` and the `payouts` float logic. There is no admin role, route or UI.

### 3.2 Access model
- New table `platform_admins(user_id PK, role 'SUPER'|'SUPPORT'|'FINANCE', created_by, created_at)`; seeded from env `OLLO_ADMIN_EMAILS` on first boot.
- Route prefix `/admin` (SPA shell) + `/api/admin/*`; middleware requires session user ∈ `platform_admins`. Separate rail, separate colour accent (ink on cream) so nobody mistakes it for a shop.
- **Every admin write is audited** to `admin_audit(id, admin_id, shop_id, action, before_json, after_json, reason, created_at)`; `reason` is required (min 5 chars) on destructive or financial actions.
- **Impersonation**: "Open as owner" creates a 30-minute read-write session tagged `impersonated_by`, shows a red top bar in the shop workspace, and is logged. Support-role can impersonate read-only.

### 3.3 Sections
1. **Overview** — MRR, active shops, trials ending in 7 days, past-due, failed messages 24h, Stripe float, open disputes, unresolved schedule conflicts across shops. Each tile links to the filtered list.
2. **Shops** — searchable table (name, slug, owner, plan, seats, status, MRR, last active, health). Shop detail:
   - *Summary*: owner contacts, timezone, created, last booking, counts.
   - *Subscription*: plan, seats, status, period, card on file, discounts, "Change plan", "Pause", "Extend trial", "Grant/Block feature" (with reason + optional end date), "Apply discount".
   - *Invoices*: list + "Add credit", "Add charge", "Resend", "Mark paid (offline)", "Void" — all via Stripe.
   - *Usage*: this period + last 6 months chart (SMS/WA/minutes/seats).
   - *Messaging*: outbox with failures, provider errors, resend.
   - *Payments*: Connect status, payouts, disputes (from existing `payouts.ts`).
   - *Schedule*: cross-shop `issues` and `schedule_change_log`.
   - *Support*: notes thread (`support_notes`), "Open as owner", "Send password reset", "Export data (JSON)".
   - *Audit*: shop audit_events + admin_audit merged timeline.
3. **Billing** — plans & features editor (name, price, included units, publish to Stripe), discount codes (create/expire, redemptions), all invoices (filter by status/period), revenue by month, churn list.
4. **Features** — matrix shops × features (checkbox = enabled, tooltip shows source PLAN/ADDON/GRANT/BLOCK). Bulk "grant to all trials".
5. **Ops** — provider health (Resend/ClickSend/WA/Stripe/ElevenLabs), failed webhooks (`stripe_events` unprocessed), reminder sweep last run, cron status.
6. **Team** — platform admins CRUD (SUPER only).

### 3.4 API surface (all `/api/admin`, all audited)
`GET /overview` · `GET /shops?q&status&plan` · `GET /shops/:id` · `POST /shops/:id/subscription` (plan/seats/pause/resume/trial_ends) · `POST /shops/:id/features` `{key, enabled, source:'ADMIN_GRANT'|'ADMIN_BLOCK', ends_at?, reason}` · `POST /shops/:id/discounts` · `GET /shops/:id/invoices` · `POST /shops/:id/adjustments` · `POST /invoices/:id/{resend|void|mark-paid}` · `POST /shops/:id/impersonate` · `POST /shops/:id/notes` · `GET|POST|PUT /plans` · `GET|POST|PUT /features` · `GET|POST /discounts` · `GET /ops/*` · `GET|POST|DELETE /admins`.

### 3.5 Acceptance tests
- Non-admin hitting `/admin` → 404 (not 403, to avoid enumeration); admin sees Overview.
- Grant feature with reason → `shop_features` row + `admin_audit` row; shop workspace reflects within one heartbeat (`/changes` cursor bumps).
- Apply discount → Stripe coupon attached; invoice preview shows discount line.
- Impersonate → red bar in shop, session expires at 30 min, audit row with admin id.
- SUPPORT role cannot access Billing → plans editor (403 + audit "denied").

Effort: **~6 days** (auth/shell/audit 1, Shops list+detail 2, Billing/Features/Discounts 2, Ops/Team 1).

---

## 4. Staff photos on the calendar

### 4.1 What exists
`staff.photo_url` (uploaded via `/media`, `PhotoUpload` in Studio), used on the public page and Team cards. Calendar day/week headers use `Avatar` with initials + colour only.

### 4.2 Change
- `Avatar` gains `src?: string`: renders `<img>` (object-fit cover, lazy, `onError` → fall back to initials) inside the existing coloured circle; colour ring kept as a 2px border so the barber colour remains legible with a photo.
- Day view header: 32px photo avatar; week view/strip: 24px; barber filter dropdown and appointment panel "with Jay" line: 20px. Move-on-timetable banner and conflict dialog suggestions: 20px.
- Public booking page barber picker already shows photos — no change.
- Missing photo → current initials avatar (no layout shift, same size box).
- Team card gets "Add photo" nudge if `photo_url` empty ("Photos show on your calendar and booking page").

Acceptance: visual baselines updated; `img` has `alt={name}`; broken URL falls back without console error.

Effort: **0.5 day**.

---

## 5. Order of work and milestones

| # | Workstream | Days | Depends on | Ship gate |
|---|---|---|---|---|
| 1 | Staff photos on calendar | 0.5 | — | visual tests |
| 2 | Conflict preview + resolution dialog (all 5 entry points) | 2.5 | — | tests 1.4 (1–4) |
| 3 | Shifts page (Day/Week/Leave) | 1.5 | 2 | test 1.4 (5) |
| 4 | Billing schema + entitlements + feature gates in UI | 1.5 | — | unit tests |
| 5 | Stripe Billing: customer, subscription, seats sync, add-ons, webhooks, invoices mirror | 2.5 | 4, **Stripe key** | test-clock run |
| 6 | Usage metering (SMS/WA/minutes) + Billing tab with live usage & invoices | 1.5 | 5 | integration test |
| 7 | Dunning + read-only mode | 1 | 5 | dunning test |
| 8 | Admin: auth, shell, audit, impersonation, Shops list/detail | 3 | 4 | tests 3.5 |
| 9 | Admin: Billing/Features/Discounts/Ops/Team | 3 | 5, 8 | tests 3.5 |

Total ≈ **17 engineering days**. Items 1–4 and 8 can start now with no external input. Items 5–7 and 9 need the **live Stripe secret key (Billing enabled) + webhook signing secret** added to Vercel env, plus your decision on VAT handling (Stripe Tax on, or manual 20%).

## 6. Decisions needed from you
1. **VAT**: use Stripe Tax (automatic, ~0.5% fee) or fixed 20% UK VAT with your VAT number on invoices?
2. **Trial**: 14 days no card, or card up front? (Plan assumes no card, 14 days.)
3. **Seat change timing**: prorate immediately (plan assumes yes) vs. bill at next period.
4. **Dunning grace**: 7 days before read-only (plan assumes 7).
5. **Admin emails** to seed `platform_admins`.
6. Should shops be able to **self-serve add-on removal** immediately (lose access now, credit unused days) or only at period end? (Plan: period end by default, immediate optional.)

Reply with the answers (or "go with the plan defaults") and I'll start with workstreams 1, 2 and 4 immediately.
