# Plan: Block Time · Chair Rent / Splits in Pay Runs · Staff Holiday

_2026-09-21 · foliyo. Written after auditing the code that already exists so nothing is rebuilt twice._

---

## 0. Audit — what is already there, and what is broken or missing

### 0a. Block Time (request 1) — **largely built, one gap**

| Piece | State | Evidence |
|---|---|---|
| `staff_blocks` table (date, 15-min start/end, `kind` LUNCH/TRAINING/PERSONAL/SICK/OTHER, reason) | ✅ | `0013_staff_blocks.sql` |
| Availability refuses slots overlapping a block ("Blocked time") — workspace **and** public booking | ✅ | `domain.ts:1174 slotReason`, `public.ts:252` loads blocks |
| DB trigger rejects a booking that lands on a block | ✅ | `schema.sql:746` |
| Calendar ⋯ menu → "Block time…" → `BlockDialog` with preview of clashing visits → move / cancel / keep + customer notification | ✅ | `Calendar.tsx:571`, `BlockDialog.tsx`, `tests/blocks.spec.ts` (2 pass) |
| Barber can block their **own** time (route uses `scopeStaff`, not owner-only) | ✅ API | `sandbox.ts:1901-1939` |
| **Recurring blocks** (lunch 1–2pm every day) | ❌ missing | must be re-added daily |
| Block from the **Shifts** page / barber profile, not just the day-view ⋯ menu | ❌ missing | |
| Block on a **past-dated** day disabled (fine), but no **multi-day** block (use day-off / holiday instead — see §3) | by design | |
| Shown to barber in their own calendar view | ✅ grey card | |

**Verdict:** ship a *recurring lunch/break* pattern and a second entry point; the core requirement (customers can't book blocked time) is already true and tested.

### 0b. Pay Runs (request 2) — **engine exists, presentation and model gaps**

Current engine (`domain.ts calculatePayRun`, `payouts.ts settlementFor`):

| Pay model | What it does today |
|---|---|
| `COMMISSION` | barber = takings × pct (or marginal tiers) + tips × tip-share |
| `CHAIR_RENT` | barber keeps takings; net = tips-share − rent × periods (barber pays shop) |
| `HOURLY` / `SALARY` / `HYBRID` | fixed pay (+ commission above threshold for HYBRID) |
| Adjustments | free-form ± lines per run, plus auto-adjustments (deposit refunds) |
| Settlement | card vs cash split, Stripe transfer to barber / shop, reserve %, "cash residual" to settle by hand |

**Problems found**

1. **No "owner share" line.** A 60/40 split is entered as `commission_pct = 60`; the screen shows "Commission £X" but never *"Owner's 40% = £Y"*. The owner can't see what the business keeps. → Add derived `owner_pence` and show both shares on every run.
2. **Rent and commission are mutually exclusive.** Real deals are often *both* ("£150/week chair + 10% of product sales", or "40% split with a £50/week supplies charge"). `pay_model` is a single enum; `rent_pence` only applies to `CHAIR_RENT`. → Introduce **recurring deductions** independent of model (§2).
3. **Rent proration is naive.** `rent_pence * periods` where `periods` is fixed at 1 in preview; a monthly rent on a weekly run isn't prorated, and a barber on holiday for the week still owes full rent. → Deduction has its own cadence (WEEKLY/MONTHLY/PER_RUN) with proration + optional "waive while on approved leave".
4. **PUT recompute ignores tiers/hybrid threshold properly** — it re-sums stored fields, so an edited adjustment on a HYBRID run is fine, but a **changed term** isn't reflected until a new run. Acceptable (runs snapshot terms) but must be stated on screen: "Terms frozen at creation".
5. **Product sales commission (`product_commission_pct`) is stored but never used** — no product ledger exists. Leave as-is; note in UI.
6. **Screen doesn't answer "how did you get this number?"** in the order the owner asked for: Total sales → staff share → rent → owner % → other deductions → owed to staff → owed to business. The current `pay-breakdown` mixes them. → New statement layout (§2.4).
7. **Barber wallet visibility** — see 0c.
8. **Pay runs live only under Team → barber → Pay tab** (owner/manager). No "this week's pay runs for everyone" view; no bulk create. → Add a **Pay Runs** page.

### 0c. Barber wallet / earnings visibility — **partially visible, inconsistently**

| Surface | Barber sees? | Notes |
|---|---|---|
| Wallet chip + drawer (`/payments/wallet?owner=STAFF`) | ✅ own takings, tips, visits by method | `Wallet.tsx`, `scopeStaff` enforced |
| `by_staff[].commission / earnings` in wallet | ⚠️ computed with flat `commission_pct` only — **ignores tiers, HYBRID base, CHAIR_RENT** so a chair-rent barber sees a fake "commission" figure | `walletFor` |
| Pay runs list `GET /pay-runs` | ✅ filtered to own `staff_id` | |
| Pay run **screen** (`PayRuns` component) | ❌ **not reachable** — it is only mounted inside `BarberStudio` under **Team**, and Team is hidden for `BARBER` role (`Workspace.tsx:1669-1677`) | Barber has an API they can call but no UI |
| Pay **terms** (their own deal) | ❌ not visible to barber | |
| Payout account card (Stripe onboarding for their own transfers) | ✅ (`payouts.spec.ts` role-boundary test) | |
| Estimated **this-period earnings** | ❌ | wallet shows takings not pay |

**Verdict:** add a **"My pay"** section for barbers (terms summary, current-period estimate using the real engine, pay-run history with statements, payout account). Fix `walletFor` to call `calculatePayRun` so the earnings number is the same one the owner sees.

### 0d. Holiday (request 3) — **only a primitive exists**

| Piece | State |
|---|---|
| `staff_days_off` (date + reason, no type, no status, no allowance) | ✅ used by "Day off" and the conflict resolver |
| Shop `holidays` (closures) | ✅ separate concept — keep |
| Allowance, taken/pending/remaining, requests, approval, approval-mode setting, unplanned vs holiday | ❌ none |

`staff_days_off` will become the **leave ledger** (§3) — migrate in place, don't create a parallel table, so all existing availability/trigger/resolver code keeps working.

---

## 1. Block Time — finish it

### 1.1 Recurring blocks
- New table `staff_block_rules` (shop_id, staff_id, weekdays bitmask, start_min, end_min, kind, reason, starts_on, ends_on nullable, active).
- Availability: `slotReason` also checks rules for the date's weekday (rules materialise virtually — no nightly job). Public + workspace both call the same helper.
- Conflict handling on creation: preview across the next 8 weeks (reuses the block preview engine), same move/cancel/keep resolver.
- UI: `BlockDialog` gains "Repeat: every [Mon–Sun chips] until [date/never]". Existing single-day path unchanged.
- Shifts → Day row shows recurring breaks as hatched segments; barber profile → Schedule tab lists rules with edit/delete.

### 1.2 Second entry point
- Barber profile (Team → Schedule) and Shifts day row both get "Block time…".
- Barber role: **Appointments** day view already has the ⋯ menu for their own column; confirm it is rendered for barbers (it is; the menu is per-staff and the API is `scopeStaff`).

### 1.3 Tests
`tests/blocks.spec.ts` + recurring rule blocks a public slot on the right weekday only; deleting the rule frees it; conflict preview lists 3 weeks of clashes.

**Effort ≈ 1 day.**

---

## 2. Pay Runs — chair rent, splits, deductions, clear statement

### 2.1 Model

Keep `pay_model` as the **earning basis**; add **recurring deductions** as a separate list on the staff record (`staff_deductions` table):

```
staff_deductions
  id, shop_id, staff_id
  label            'Chair rent' | 'Room rent' | 'Supplies' | free text
  kind             FIXED | PERCENT_OF_TAKINGS | PERCENT_OF_STAFF_SHARE
  amount_pence     for FIXED
  pct_x100         for PERCENT (e.g. 1000 = 10.00%)
  cadence          WEEKLY | FORTNIGHTLY | MONTHLY | PER_RUN     (FIXED only)
  proration        FULL | BY_DAYS                                (charge full amount per cadence unit, or per calendar day covered)
  waive_on_leave   0/1   (skip days with APPROVED holiday/sick — see §3)
  starts_on, ends_on nullable, active, sort
```

Owner-facing presets when adding: **Chair rent (weekly £)**, **Room rent (monthly £)**, **Percentage split** (sets `pay_model=COMMISSION`, `commission_pct`, and shows owner % automatically), **Other deduction** (free label; fixed or %).

Existing `CHAIR_RENT` model + `rent_pence` → migration creates a `staff_deductions` row `Chair rent / FIXED / rent_pence / cadence = pay_period` and sets `pay_model = 'KEEP_ALL'` (new basis: barber keeps 100% of takings; deductions come off). `CHAIR_RENT` enum value kept for old `pay_runs.terms_json`.

### 2.2 Calculation (pure, unit-tested — extends `calculatePayRun`)

```
gross_sales        = service takings in period (ledger)          [Total sales]
tips_pool          = tips in period
staff_gross        = by basis:
                       COMMISSION/HYBRID → commissionFor(...) (+ base)
                       KEEP_ALL          → gross_sales
                       HOURLY/SALARY     → hours×rate / salary
staff_tips         = tips_pool × tip_share_pct
owner_gross        = gross_sales − staff_gross (never < 0)        [Owner's %]
deductions[]       = each active staff_deduction for the period:
                       FIXED  → amount × units (units = period length ÷ cadence, prorated BY_DAYS if set;
                                minus waived leave days when waive_on_leave)
                       PERCENT_OF_TAKINGS      → gross_sales × pct
                       PERCENT_OF_STAFF_SHARE  → (staff_gross + staff_tips) × pct
adjustments[]      = manual ± lines + auto (deposit refunds)      [Other deductions / bonuses]
owed_to_staff      = staff_gross + staff_tips − Σdeductions + Σadjustments
owed_to_business   = owner_gross + Σdeductions − Σ(positive adjustments paid by shop)
```

Both totals are stored on the run (`owner_pence`, `deductions_json`, `deductions_pence`, `owed_to_business_pence`) so history is exact even if terms change later. Settlement (`settlementFor`) uses `owed_to_staff` as `net_pence` — unchanged contract, so Stripe transfers keep working.

### 2.3 Rules the engine enforces
- Deductions can't take `owed_to_staff` below **−(gross cash the barber holds)** without an explicit owner override flag ("barber will pay the shop £X by hand") — surfaced, not silently allowed.
- A run's `terms_json` now includes the deductions snapshot. Editing a draft's manual adjustments recomputes with the **snapshot**, not live terms (fixes audit item 4 properly, and says so on screen).
- Fortnightly/monthly runs vs weekly rent: units = exact calendar coverage (e.g. 1–30 Sep with weekly rent = 4.29 weeks → BY_DAYS; or 4 whole weeks → FULL, owner picks per deduction).

### 2.4 Pay-run statement (owner *and* barber see the same)

```
Period 15–21 Sep · Jay Carter · Commission 60/40

Total sales (ledger)                         £1,240.00   (31 paid visits)
  Card £980.00 · Cash £260.00
Tips                                            £86.00

Jay's share  60% of sales                     £744.00
Tips to Jay  100%                              £86.00
                                             ─────────
Gross to Jay                                  £830.00

Deductions
  Chair rent · weekly                         −£150.00
  Supplies · 5% of sales                       −£62.00
Other
  Late fee (owner note)                        −£20.00
  Product bonus                                +£35.00
                                             ─────────
Owed to Jay                                   £633.00
   of which card money via Stripe             £588.00  · cash Jay already holds £260.00 → shop owes £45.00 by hand   [existing settlement panel]

Owed to business
  Owner's share 40%                            £496.00
  Chair rent                                   £150.00
  Supplies                                      £62.00
  Late fee                                      £20.00
  less Product bonus                           −£35.00
                                             ─────────
                                               £693.00
```
Every line links back to what produced it (terms, deduction rule, adjustment author). Printable statement page `/pay-run/:id?t=token` (same pattern as invoices) for the barber's records / accountant.

### 2.5 New "Pay Runs" page (owner/manager)
- Period picker (weekly/fortnightly/monthly, previous by default) → table of every active barber: sales, owed to staff, owed to business, status. **Create all drafts** in one click; approve individually. Totals row = what the shop pays out / keeps this period.
- Filters: unpaid only; export CSV (accountant).

### 2.6 "My pay" (barber)
New nav item for `BARBER` role: my deal (read-only summary), current-period estimate (live engine), pay-run history with statements, payout account card (moved from Settings), and — from §3 — my holiday balance. Owner controls whether barbers see the **owner's share** line (`shop.pay_show_owner_share` default on: transparency is the point of splits).

### 2.7 Fixes from audit
- `walletFor.by_staff` uses `calculatePayRun` per barber (flat commission bug).
- PUT `/pay-runs/:id` recompute from snapshot.
- Copy: "Terms and deductions are frozen when the draft is created; void and recreate to pick up changes."

### 2.8 Tests
Unit (`tests/domain.test.ts`): 60/40 split; weekly rent on monthly run FULL vs BY_DAYS; rent waived for 2 approved holiday days; % of staff share; negative-owed guard. E2E (`tests/payruns.spec.ts`): owner adds chair rent + split → statement shows all seven figures matching by hand; barber opens My pay and sees identical numbers, cannot see other barbers; bulk create.

**Effort ≈ 3 days.**

---

## 3. Staff Holiday & Time Off

### 3.1 Model — evolve `staff_days_off` into the leave ledger

```
staff_days_off (existing) +
  type          HOLIDAY | UNPLANNED | SICK | OTHER        (was implicit in `reason`)
  status        REQUESTED | APPROVED | DENIED | CANCELLED (existing rows → APPROVED)
  half          '' | AM | PM                               (half days count 0.5)
  requested_by, requested_at, decided_by, decided_at, decision_note
  counts_against_allowance 0/1  (HOLIDAY=1; UNPLANNED/SICK/OTHER=0 by default, owner can flip)
  leave_year    'YYYY' derived from shop.leave_year_start (default 1 Jan; owner can set 1 Apr etc.)

staff +
  holiday_allowance_days  REAL (default shop.default_holiday_days = 28)
  allowance_adjustments   via table staff_allowance_adjustments(id, staff_id, leave_year, delta_days, reason, by, at)  — owner adds/removes days with a reason

shops +
  holiday_approval  ALL | OVER_ALLOWANCE | NONE  (default ALL)
  default_holiday_days, leave_year_start_month, min_notice_days (default 0), max_consecutive_days nullable
```

Balance for a barber/year = `allowance + Σadjustments − taken(APPROVED, past or future, counts=1) − pending(REQUESTED, counts=1)`. Shown as **Allowance · Taken · Booked ahead · Pending · Remaining**.

### 3.2 Availability & bookings
- Only `APPROVED` rows block availability / trigger the DB abort (`status='APPROVED'` added to the existing `staff_day_off` checks). A pending request **does not** block customers — but the calendar shows it hatched with "Holiday requested" so the owner sees it.
- Approving runs the **existing conflict resolver** (`previewChange kind: day_off`) for each date — the owner resolves clashing appointments as part of approval. Denying leaves everything as is.
- A barber cancelling an approved future holiday just frees the days.

### 3.3 Approval modes (shop setting)
| Setting | On request |
|---|---|
| **All holiday needs approving** | status `REQUESTED`; owner notified (alerts pref `leave_request`, email/SMS like other owner alerts) |
| **Approve after allocation** | if `remaining − requested_days ≥ 0` → auto `APPROVED` (still logged, still runs conflict check and returns clashes to the barber as "the shop will move these"); else `REQUESTED` with reason "over allowance by N days" |
| **Approval off** | always `APPROVED`; recorded against allowance; owner gets an FYI alert |
Unplanned/sick: always logged immediately as `APPROVED` (it already happened) by owner or barber; owner can reclassify to HOLIDAY (then it counts) — this is how "unplanned off" is kept separate but trackable.

### 3.4 Where it lives
- **Barber (My pay → Holiday tab, and calendar)**: balance card; "Request holiday" from the calendar day/⋯ menu or a date-range picker (multi-day, half-day toggle, note); list of my requests with status; cancel pending/approved-future.
- **Owner (Team → barber → Schedule tab)**: balance card; allowance ± with reason; every request with approve/deny (deny needs a note); log unplanned/sick for them; history per leave year.
- **Owner (Shifts → Leave tab, exists)**: becomes the **inbox** — pending requests first with Approve/Deny inline, then upcoming approved leave, then the month grid. Badge count on the Shifts nav item.
- **Settings → General → Holiday**: approval mode, allowance default, leave-year start, notice/consecutive limits.
- **Notifications**: barber gets `leave_approved` / `leave_denied` (email/SMS via existing enqueue; new templates); owner gets `owner_leave_request`.
- **Pay runs**: approved holiday days feed `waive_on_leave` deductions (§2) and are listed on the statement ("2 holiday days · rent waived £42.86"). Holiday **pay** for employed staff is a manual adjustment preset ("Holiday pay") — no statutory calc in this phase.

### 3.5 Migration
`0023_leave.sql`: add columns with safe defaults, backfill `type='OTHER', status='APPROVED'` for existing rows (reason text mapped: contains "holiday"→HOLIDAY, "sick"→SICK), add shop/staff columns, update the two DB checks to `status='APPROVED'`. Existing tests (`schedule-conflicts`, `workspace` leave tests) must stay green.

### 3.6 Tests
`tests/leave.spec.ts`: each approval mode; balance maths incl. half days and owner adjustment; pending doesn't block a public booking, approved does; approval runs the resolver on a clashing appointment; barber can't approve their own; deny requires note; leave-year rollover.

**Effort ≈ 3 days.**

---

## 4. Order of work

| # | Work | Days | Depends on |
|---|---|---|---|
| 1 | Pay-run engine: deductions model + migration, `calculatePayRun` v2, statement fields, `walletFor` fix, unit tests | 1 | — |
| 2 | Pay-run statement UI (owner), Pay Runs page with bulk create, printable statement | 1 | 1 |
| 3 | **My pay** for barbers (terms, estimate, history, payout card) | 0.5 | 2 |
| 4 | Leave model + migration + approval modes + availability change | 1 | — |
| 5 | Leave UI: barber request flow, owner inbox (Shifts → Leave), profile balance/allowance, settings, notifications | 1.5 | 4 |
| 6 | Rent waived on leave; holiday days on statement | 0.5 | 1, 4 |
| 7 | Recurring blocks + second entry point | 1 | — |
| 8 | Docs, plan §4b update, prod migration | 0.5 | all |

**≈ 7 days.** Items 1–3 and 4–5 are independent; 7 is independent of both.

## 5. Decisions I'll take unless you say otherwise
- Default allowance **28 days**, leave year **1 January**, approval mode **All holiday needs approving**.
- Barbers **can** see the owner's share on their statement (owner can turn off).
- Unplanned/sick **does not** count against holiday by default.
- A pending request never blocks customer bookings; approval does.
- Rent is charged on the run's calendar coverage (BY_DAYS) by default for mismatched cadences; FULL when cadence matches the run.
- Existing `CHAIR_RENT` barbers are migrated to "keeps all takings + Chair rent deduction" with identical numbers.
