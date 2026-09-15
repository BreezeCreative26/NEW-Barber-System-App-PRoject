# Barbershop OS — Progress and next-session handoff

## Latest — design system + new shell (2026-09-14)

- **Design system is now code.** `public/static/design.css` holds every token (`:root`) and the shared components from the approved mockups: top bar, icon rail, phone tab bar (+ More sheet), toolbar, wallet hero, KPI and method tiles, transaction row, status pill, block icons, blocked-time fill, card, right drawer. `docs/DESIGN.md` documents tokens, components, screen patterns and the definition of done. React primitives in `ui.tsx`: `TopBar`, `Rail`, `TabBar`, `WalletHero`, `KPI`, `TxRow`, `StatusPill`, `BlockIcons`; 20 new Lucide icons registered.
- **Shell migrated.** Workspace now renders `TopBar` (brand, search, "Local test data" pill, wallet chip = booked value today, bell = schedule issues, account pill), a 64 px `Rail` on ≥768 (Audit + Accounts pinned bottom, tooltips) and a `TabBar` on phones (Today · Insights · **+** · Customers · More → Team/Services/Settings/Audit/Accounts). Old text sidebar and banner removed. The FAB opens New booking. Top bar never overflows (text truncates/hides; checked at 200 % zoom).
- **Guardrails (`npm run test:design`, part of `npm test`):** design.css may only use raw colours inside `:root`; no emoji anywhere in `src/`; no stray stylesheets; legacy `style.css` is frozen at its current line count (`tests/design-legacy-cap.txt`) and may only shrink. **Visual baselines (`npm run test:visual`):** owner calendar at 1440/768/390, entry hub, public booking — in `tests/__screenshots__/`; any change fails until refreshed deliberately.
- Tests: shared `section()` helper (fixture.ts) handles rail vs tab bar vs More sheet and the Today/Appointments alias; accounts nav expectations updated for both layouts. Full gate: tsc, design guardrails PASS, vitest 26, D1 PASS, **Playwright 103 passed / 1 skipped / 0 failed**. Evidence `docs/evidence/v7-shell-{1440,768,390}.png`, `v7-shell-390-more.png`; axe clean, no overflow.
- Next slice: checkout that records payments (cart → tip → method) and the shop wallet drawer + barber Today/Wallet screens built from these components.

## Earlier — one project, every view; fixture pages removed (2026-09-14)

- Deleted the static design-fixture surfaces: `/preview/admin|book|barber` routes, `src/client/{Admin,Book,Barber}.tsx`, `PreviewBar`/`StateEnvelope`/`Scenario` in ui.tsx, the sample data in `fixtures.ts` (now only `money`/`time`/`datePlus`/`dateLabel`), `tests/preview.spec.ts` and the fixture unit tests. Root `/` now always redirects to `/workspace`; unknown pages 404 with a pointer to `/workspace`, `/book/<shop>`, `/manage/<token>`. Client bundle 749 kB → 645 kB.
- `main.tsx` is a single router: `/book/:slug` → PublicBooking, `/manage/:token` → ManageBooking, everything else → Workspace.
- Entry screen is now a **project hub** for the one shared Demo Barbershop: four rows — Owner/admin (Open as owner), Barber (Open as barber), Customer booking (opens `/book/demo`), Customer manage link (reached via an appointment's Share) — plus Rebuild demo data and the credentials. "Start a blank test shop" is folded into a collapsed `<details>` for tests/edge cases. Sidebar "Design references" links removed.
- Tests: `enter()` helpers expand the collapsed blank-shop card; entry-screen test asserts the four hub rows, `/preview/*` 404s and root redirect; unit test rewritten for the new route boundaries (26 vitest). Full gate: tsc, vitest 26, D1 invariants PASS, **Playwright 98 passed / 1 skipped / 0 failed** (25 fixture-page tests removed). Evidence `docs/evidence/v6-entry-{1440,390}.png`, axe clean, no overflow.

## Earlier — faster build loop (2026-09-14)

- **Working rule (AGENTS.md):** fast loop / slow gate. Iterate with `npm run test:area -- tests/<file>.spec.ts [-g name]`; run the full `npm test` gate once per task before the commit; batch screenshots/docs at handoff.
- **Playwright:** workers now `max(2, 2×CPU)` (override with `PW_WORKERS`), `fullyParallel`. Full suite 4.0 min → 3.6 min on this 2-core box; the wrangler dev worker is the bottleneck, so more workers give diminishing returns. Affected-file runs are ~1–1.5 min.
- **Parallel-safe seeded fixtures:** `POST /auth/demo {fixture:true}` builds a private copy of the demo seed (own slug `demo-xxxxxxxx`, own emails) and signs in; the shared demo shop is untouched. `tests/fixture.ts` exposes `openFixtureShop(page)`; the three browser tests that previously rebuilt the shared demo now use it (no cross-test races, no serialisation). Only the demo-account test rebuilds the shared demo.
- Verified: tsc, build, full Playwright **123 passed / 1 skipped / 0 failed**.
- Slowest remaining tests are the 5-width responsive loops (7–9 s each ×15) and the 503-record pagination case (20 s); candidates for trimming if the gate needs to get faster.

## Earlier — OLLO rebrand (2026-09-14)

- Logo supplied by the user (calendar-bot mark in periwinkle `#6985e8` on cream, navy `#181b2a` wordmark). Saved to `public/static/brand/` (source PNG, transparent PNG, hand-drawn `ollo-mark.svg` used for favicon, sidebar brand and "Powered by" chips).
- Palette: `:root` tokens re-pointed (`--accent #4a5fd9`, `--accent-dark #3546b4`, `--ink #181b2a`, `--muted #5b6178`, `--line #e2e4ee`, `--canvas #f5f6fb`, new `--ollo`, `--ollo-soft`, `--cream`). ~370 hard-coded forest/sage hexes were hue-rotated to the brand hue with lightness preserved; over-dark navies lifted into the accent range; hero uses an accent gradient. Enum calendar colours and semantic status tones were protected so bookings still read the same.
- Brand strings: titles, theme-color, `.ics` PRODID/UID domain, "Booked with OLLO", `Brand` component and public "Powered by OLLO". `localStorage` key `barbershop-os:customer` deliberately kept so returning testers keep saved details.
- Contrast: eleven small-text-on-blue pairs failed AA after the rotation (in-chair card, on-dark badge, week strip, nav count, method chip); fixed to white / accent-dark. axe clean on entry, calendar (1440/390), service studio, public booking (1440/390) and the preview fixtures.
- Verification: tsc, build, targeted a11y suites 22/22, preview suite 25/25, **full Playwright 123 passed / 1 skipped / 0 failed**. Evidence `docs/evidence/v5-ollo-{entry,calendar,services,public,calendar-390,public-390}.png`.
- Why builds feel slow: the Vite build is ~0.7 s; the full browser suite is ~4 min and runs before every commit. Iterating now uses targeted suites, with one full run at the end.

## Earlier — demo account, origin fix, customers, appointment panel, service & barber studios (2026-09-14)

Five requested items plus the login blocker, built as slices 0–4. Everything is local D1, fictional data, nothing live.

**Slice 0 — login "origin error" (root cause fixed) + standard demo account**
- Root cause: the sandbox preview proxy terminates HTTPS and forwards plain HTTP without `X-Forwarded-*`, so the browser's `Origin: https://…` never string-matched the worker's `http://…` URL and every mutation (including sign-in) returned 403. `sameOrigin` in `src/server/accounts.ts` now: exact origin → `Sec-Fetch-Site` same-origin/same-site → host-only comparison (`url.host`, `Host`, `X-Forwarded-Host`) → `Referer` host when `Origin` is absent → `ALLOWED_ORIGINS` env allowlist. Foreign origins and missing evidence still 403; a rejected request logs `origin_forbidden` diagnostics. `GET/POST /api/origin-check` echoes what the worker receives. Verified in a real browser through the public preview URL.
- `src/server/demo.ts`: deterministic seed (fixed RNG) for *Demo Barbershop* (slug `demo`): 3 barbers with title/bio/colour/skills/instagram, 8 services with colour/description/popular, 4 add-ons, per-barber rules, ~126 bookings from −70 to +14 days across every status and both channels, standing series, 2 open waitlist entries, a day off, and a barber account created via a pre-accepted invitation. `POST /api/sandbox/auth/demo {rebuild?, as?: owner|barber}` opens (or rebuilds) it and sets the account cookie. Credentials `owner@demo.test` / `jay@demo.test`, password `Demo1234!`. Entry screen gained an "Open the demo shop" card with Open as owner / Open as barber / Rebuild demo and prefilled sign-in.

**Slice 1 — customers as first-class records**
- Migration `0009_customers.sql`: `customers` (name, phone unique per shop, email, notes, tags JSON, `merged_into`, version), `bookings.customer_id`, trigger that links a new booking to the customer with the same phone (creating one if needed), indexes.
- API: `GET /customers` (`q`, `filter` all/new/regulars/lapsed/no_shows/upcoming, `sort` recent/next/spend/visits/name, `limit`), `POST /customers`, `GET /customers/:id` (id or phone; merged → target; stats: visits, completed, no-shows, spend, favourite barber/service, average gap, first/last/next), `PUT /customers/:id` (versioned), `POST /customers/:id/merge {into}` (moves bookings, sets pointer). Barber accounts see only customers they have served. `createBooking` accepts optional `customer_id` (validated in-shop, excluded from the idempotency hash).
- UI: Customers tab rewritten — directory with filter chips, sort, search, avatar initials; profile with stat cards, favourites, tags/notes editing, contact edit, full history that opens the appointment panel, **Book** button, and Merge. Booking form gained a **customer picker** (search → pick → "Book as someone else" / add new with duplicate-number warning); `customer_id` travels with `/bookings` and `/series`.

**Slice 2 — appointment side panel**
- `src/client/AppointmentPanel.tsx`: right-hand drawer ≥900px, bottom sheet below; header with customer/service/barber/time/price, status-aware primary actions (check in → start → complete; no-show; reschedule; cancel; book again; edit details; share; open customer), inline note (PATCH details), timeline from `GET /bookings/:id/timeline` (audit-derived), and for standing bookings **Cancel remaining** / **Move remaining** (`POST /series/:id/cancel|reschedule` with optional `from_booking_id`; each occurrence through the shared guards). Dirty/busy switching guard ported from the modal. Legacy controls (items, status form, share) remain under an expandable "More" section so earlier flows and tests still work.

**Slice 3 — Service studio**
- Migration `0010_catalogue_profiles.sql`: services gain `description, colour, online_bookable, popular, sort_order`; staff gain `title, bio, colour, photo_url, online_visible, skills (JSON), instagram, start_date, sort_order`; colour enum sage/sand/blue/clay/plum/slate.
- `PUT /service-rules {rules:[…]}`: batch matrix write — rows that equal the catalogue default are deleted, others upserted; tenant-checked staff and service ids; one `SERVICE_RULES_UPDATED` audit row. Public reads filter `online_bookable=1` / `online_visible=1` (shop read and slot assignment); owners are unaffected.
- `src/client/Studio.tsx` `ServiceStudio`: category groups of colour-coded cards (Popular / In shop only / Inactive; price · minutes · barbers offering · upcoming), search, show-inactive, New service; `ServiceEditor` tabs Details / Barbers & pricing (`RuleMatrix`) / Add-ons. Add-on chips open the existing add-on editor.

**Slice 4 — Barber studio**
- `BarberStudio`: profile cards (photo or coloured initials, title, skills, today's load, next visit, Hidden online / Inactive), search, show-inactive, Add barber (owner/manager). `BarberEditor` tabs Profile (all new fields, skills tag input with suggestions, colour picker, switches) / Schedule (weekly-hours strip + Edit weekly hours, Days off, Dated hours → existing editors) / Services & pricing (matrix from the barber side) / Performance (7/30/90d from `/insights`) / Upcoming (14 days from `/bookings/range`, opens the panel). Barber accounts read-only.
- Public `/book/<slug>` shows descriptions, Popular pill, colour thumbs, barber photo/title/bio/skills; ordering popular → sort order.
- Legacy Team/Services modal editors and `ServiceRulesEditor` removed from Workspace.tsx (dead after the studios).

**Studio safeguards added after the first test pass surfaced gaps**
- Nested `<label>` around the toggle switches made them unclickable (real bug, also an a11y smell) → switch rows are `<div>`s; the hidden input sits above the track.
- Leave guard: editors flag `data-dirty`; switching tab or closing with unsaved edits shows *Discard changes and continue* / *Keep editing*.
- Version conflict (409) shows *Discard edits and load latest*, which re-reads and resets the form.
- Save-then-failed-read: the write succeeded, so the editor locks its submit, says so, and the record is selected as soon as Retry workspace returns; no second write is offered.
- Server normalisation (e.g. Instagram `@` stripped) is mirrored back into the form after save so it isn't falsely dirty.
- axe: `.matrix-default` contrast (#8c988d → #66736a), empty matrix header now has a visually-hidden label.

**Tests** (all run against the PM2 service on :3000)
- Inventories: `PUT /service-rules`, customers, series ops and `/auth/demo` added to the source-derived mutation lists (they fail if a route is missing).
- New/changed cases: origin scenarios incl. https-vs-http and `Sec-Fetch-Site`; demo account (one-click owner/barber, fixed creds, idempotent rebuild — now rebuilds first because other suites edit the shared demo shop); entry screen; customers CRUD/filters/merge/scoping; timeline + series cancel/move; appointment panel drawer/sheet; customers tab + picker; **catalogue profiles API** (validation of https photo, handle, colour; persistence; matrix upsert/delete/atomic; cross-tenant 404; validation 400s); **public catalogue hides in-shop services and hidden barbers** while owner booking still works; **studio browser flow** (create service with colour/popular/online-off → matrix from service side → guard → barber profile with skills/photo validation/colour → schedule/services/performance/upcoming tabs → hide online → public page + axe); **barber matrix** multi-row save/revert/guard (replaces the old per-rule modal test). Old tests that drove the modal editors were rewritten against the studios.
- Final: `tsc` clean; **42 vitest**; D1 invariants PASS; **Playwright 122 passed, 1 skipped, 0 failed** after the demo-rebuild fix (accounts suite 20/20 re-run green).
- Evidence: `docs/evidence/v4-services-{1440,390}.png`, `v4-service-editor-{1440,390}.png`, `v4-team-{1440,390}.png`, `v4-barber-editor-{1440,390}.png`, `v4-barber-schedule-{1440,390}.png`, `v4-public-services-1440.png`.

**Not done / next**: photo upload (URL only), drag-to-reorder (numeric order fields), customer ratings/reviews, marketing consent and messaging (provider + consent decisions), deposits/payments, per-service buffer (shop-wide 10 min stays), bulk price changes across a category. Migrations next prefix **0011**.

## Earlier — week view, standing bookings, insights (2026-09-14)

- Migration `0008_booking_series.sql`: `bookings.series_id` (immutable via trigger), index `booking_series_lookup` (renamed after a local name clash with the `booking_series` table — fresh DBs run the corrected file cleanly), table `booking_series`.
- Server: `GET /bookings/range?from&to` (≤31 days, compact columns, LIMIT 2000, barber-scoped), `GET /insights?days=7..365` (one D1 batch), `POST /series/preview` (per-date `availabilityContext` + `slotReason`, honours `skip_dates`) and `POST /series` (inserts `booking_series`, loops shared `createBooking(..., {seriesId})`, 409 if <2 bookable or unresolved conflicts, audits `SERIES_CREATED`). Permissions added for all four.
- Client: `WeekView` in Calendar.tsx (Monday-start heads with count·load% bar, per-barber rows, ↻/online markers, hatched days off, `role="group"` cells); Workspace gains a Week segmented button + range fetch, an Insights nav item/`InsightsPanel` (period segmented, 6 stat cards, hour/weekday/services bars, barbers table, daily trend), and BookingForm gains Standing-booking controls, a review-step date list with Skip toggles, client-side refusal until conflicts are skipped, and a created/failed status line. `saved()` lands on the first created series date. New `repeat` icon.
- CSS appended: `.week-*`, `.insight-*`, `.series-*` with ≤740px horizontal-scroll week grid; contrast fixes for closed/off cells after axe flagged `#9aa69c`.
- Tests: mutation inventory now lists `/series/preview` and `/series`; barber nav expectation includes Insights; new API cases (range bounds/scoping/shape, insights validation/tenant scoping, series preview→refuse→skip→create→re-preview→validation→audit) and browser cases (week view drill-down/dialog/axe, standing-booking flow, insights tab at 1440/390/320 with axe). Final run: typecheck, 42 unit, D1 invariants PASS, **114 browser/API passed**, zero flaky.
- Evidence: `docs/evidence/v3-week-{1440,390}.png`, `v3-insights-{1440,390}.png`, `v3-series-{1440,390}.png` (axe clean on all six).
- Next: cancel/move a whole series from the detail dialog (currently per-visit only); series visibility in the customer directory; deposits/payments once a provider is chosen; messaging after provider + consent decisions.

## Latest — booking v2: first-available, soonest, waitlist, share by hand (2026-09-14)

- Public booking rebuilt on a shared `rangeContext`/`slotFor` evaluator: `staff_id=any` returns per-slot barber assignment (least-loaded eligible barber, name tie-break), `/next` returns the soonest bookable slot per day across the window, `/days` supports any-barber and returns a price range. UI adds a "First available" barber card, a Soonest chip strip that jumps date+time, open/low/full indicators on the date strip, Morning/Afternoon/Evening grouped times with counts, barber initials on any-barber slots, skeleton loading and on-device contact memory (localStorage, never sent).
- Waitlist: migration `0007_waitlist.sql`; `POST /api/public/shops/:slug/waitlist` upserts per phone/date/service with daypart; owner `GET /waitlist` (barber-scoped) and versioned `POST /waitlist/:id/status`. Owner Waitlist panel sits above the timetable; "Book them in" opens the booking form prefilled with a waitlist banner and links the entry as BOOKED after a successful save; "Close" dismisses.
- Share by hand: `POST /bookings/:id/manage-link` issues/rotates a hashed manage token (audited). Detail dialog gains a "Share confirmation with customer" panel with editable message, Copy, Open in SMS and Open in WhatsApp links. Confirmation/manage pages gain Google Calendar, `.ics`, Directions and "Text myself" tiles; hero gains Directions and a monogram seal. Stats card "Chair time booked" shows utilisation % of rostered hours.
- Fixed while building: React reused the footer button node across steps so a click on "Your details" could double as a form submit — buttons are now keyed per step. Waitlist inputs were unlabelled — added `aria-labelledby`. Slot barber initials/group headings failed AA contrast at 9px — bumped to 10px/#4d5d48 and #55664f; axe clean at 320/390/1440 on barber, times, waitlist and owner views.
- Tests: `tests/public.spec.ts` now 13 cases (added any-barber assignment/eligibility/next, waitlist API + tenant isolation, manage-link rotation, and a browser flow covering first-available → full day → waitlist → soonest chip → confirm → owner Book-them-in → Share panel). Mutation inventories updated for `/shops/:slug/waitlist`, `/bookings/:id/manage-link`, `/waitlist/:id/status`. Final run: typecheck, 42 unit, D1 invariants, **108 browser/API passed**, zero flaky.
- Evidence: `docs/evidence/v2-barber-{320,390,1440}.png`, `v2-time-any-{320,390,1440}.png`, `v2-waitlist-{320,390,1440}.png`, `v2-owner-waitlist-{390,1440}.png`, `v2-owner-waitlist-book-1440.png`, `v2-owner-share-1440.png`.
- Next: week view for owners; recurring/standing bookings; deposits/payments (Model A) once a provider is chosen; automatic messaging only after provider + consent decisions; customer-facing barber bios/photos.


## Latest — connected online booking, manage links and customers (2026-09-14)

- Built the customer journey for real: `/book/:slug` reads the shop's live catalogue/barbers/rules/hours and books through the shared `createBooking` path (same quote, availability, lead-time/window and D1 trigger guards as the owner). `channel='ONLINE'` and optional email saved; owner timetable/stats/detail/customers show an Online badge. Migration `0006_public_booking.sql` adds shop slug/online/lead/window, booking channel/email, unique slug index and hashed `booking_manage_tokens`.
- `/manage/:token` lets a customer view, move (own slot excluded, same barber/service), cancel (late-change flagged against the snapshot policy) and download `.ics`. Tokens are 72-char capability strings hashed at rest; short/garbage tokens 404; writes require same origin and current version; public availability never says who holds a slot. Throttles are scoped per shop/IP, per phone and per booking, using the existing `auth_throttle` table.
- Owner side: Settings → Online booking panel (slug suggestion, on/off, notice, window, copy/open link; `slug_taken` handled), new Customers tab (grouped by phone with visits/completed/no-shows/value/last/next, search, history → open detail; barbers scoped to own visits).
- Tests: new `tests/public.spec.ts` (9 cases: disabled/inactive hiding, slug uniqueness/validation, guards/replay/window/collision/channel, manage view/move/cancel/ics/version/origin, customers aggregation, end-to-end browser booking + move + cancel, axe/overflow at 320/390/768/1440, owner settings→customers UI at 390 with axe, public mutation inventory). Sandbox mutation inventory extended with `PUT /shop/online`; barber nav expectation updated for Customers. Final run: typecheck, 42 unit, D1 invariants, **103 browser/API passed** then 17/17 on the two touched files after inventory additions; zero flaky.
- Evidence: `docs/evidence/public-book-{390,1440}.png`, `public-manage-{390,1440}.png`, `online-settings-1440.png`, `customers-{390,1440}.png`. Fixed a mobile issue found in screenshots: confirmation/manage action rows were fixed-position and covered content at 390px; now in-flow two-column grid.
- Not done / next: confirmation and reminder messaging (needs a provider decision and consent rules), deposits/payments (Model A, shop-owned), waitlist for full days, customer-visible barber bios/photos, reception "find next available across barbers", and recurring/standing bookings. Suggested next slice: owner-triggered "send manage link" via copyable message templates (no provider) plus waitlist, then week view.


## Latest — build-first rebooking delivery (2026-09-14)

- User requested less documentation and immediate connected building. AGENTS now requires brief planning, actual code, tests and one short handoff; old plans remain references, not recurring rewrite/approval gates. Full [100-area feature brief](https://www.genspark.ai/api/files/s/sRhSuhAH) read; use as overlapping/expanded backlog, not 100 delivered features.
- Built Book again with customer/contact and available barber/service prefill, 3/4/6-week shortcuts, current-price review and a new saved identity/reference. Original visit/history stays unchanged; notes/extras are not silently copied. Added first available time for selected barber/date, explicit original/proposed reschedule comparison, review/edit focus, dirty/pending action-switch protection and saved-destination calendar navigation.
- Responsive grouped form and pinned dialog header/actions checked at 320/390/768/1024/1440/1920px, 844×390 landscape and CSS 200% zoom. Inspected real screenshots; retained `docs/evidence/rebook-review-1440.png`, `move-review-320.png`, `rebook-review-844.png`. Physical-device/screen-reader acceptance is not claimed.
- Final stable-source build/typecheck, **42 unit/route/domain tests**, direct D1 invariants and **78 browser/API tests passed**, zero failed/skipped/flaky. Report `test-results/runs/1789395309383-64889/results.json`, 14:15:09.390 UTC, 147.451s. Ten new cases cover rebooking prices/history, unavailable service, dirty/pending actions, closed dates and responsive reviews. Initial test regex matched both 5/15-minute clients; anchored it before passing runs. Final visual pass improved sticky title/Close visibility.
- HTTPS preview tested end-to-end: create fictional booking → open → Book again; zero page errors. No schema/API/dependency/provider/deployment change, no data reset. Existing feature register retained; new brief not yet exhaustively deduplicated into it. This is owner-operated rebooking, not customer identity, automatic messaging, recurring bookings or the full E2 package.
- Next: wider settings/navigation draft protection, then local account/membership/permission foundations so public/customer/barber journeys can share authorized records. Continue building from the actual source; no another comprehensive plan required. Prior sections below are historical.

Updated 2026-09-14 for **D-018 — E1 built and verified locally**. The user said “yes build” and asked for coordinated parallel tasks. This supersedes D-017's pause; no planning reset. E1 extends the same original-style persisted `/workspace`, preserving matte colours, records, APIs and all booking guards. No new identity/payment module or production deployment.

## Latest delivery — E1 calendar controls, cards and keyboard use

- `Workspace.tsx`: consolidated calendar command/date/filter panel, persistent date/view/filter choices, selected-day search/result scope and explicit Clear filters. New booking remains prominent; a timetable-origin summary keeps the initial barber/date/time distinct from current edited form fields.
- `Calendar.tsx`: 44px 15-minute cells; clearer time/name/service/status hierarchy, stable barber colours when filtering, exact labelled buffer bands even when appointment cards are filtered out, past/break/leave/closure/off-duty presentation. One free-slot tab stop per barber, directional/Home/End navigation, Enter activation, focus restoration and native appointment buttons. Focus movement performs no mutation and cells are never advertised as guaranteed service availability.
- Scoped CSS retains original matte tokens. Fixed a first-pass focus-message layout shift that consumed pointer clicks; context now sits below the grid and describes the last focused time, not an assertion that an already-saved visit is unreserved. Increased spacing and bottom-aligned buffer labels resolve short-card clipping. Unfocused skip link is clipped to avoid its offscreen appearance in full-page captures; focused skip-link semantics are unchanged.
- Eight new cases in `tests/calendar.spec.ts`: keyboard traversal over booked/buffer/break time and no extra booking, filter/colour/hidden-occupancy continuity, past/leave/closure presentation, and populated five-width long-name/5/15/30/60-minute calendar/agenda checks. Existing lifecycle, 503-record pagination, recovery and tenant/DB tests retained.

### E1 verification and evidence

- Focused final calendar suite: **14/14 passed**, report `test-results/runs/1789393976709-58771/results.json`.
- **Final unchanged-source regression:** build → typecheck → **42 unit/route/domain passed** → direct local D1 invariants passed → **68 browser/API passed**, zero failed/skipped/flaky → unchanged before/after source hash → dependency audit (0 reported vulnerabilities) → diff check. Exit 0. Report `test-results/runs/1789394389773-60993/results.json`, started **2026-09-14 13:59:49.778 UTC**, duration **132.329s**. Worker 141.76 kB (42.60 gzip); client JS 513.68 kB (122.08 gzip).
- Populated layouts tested at **320/390/768/1024/1440px** with automated axe and no document overflow. CSS 200% zoom reflow and reduced-motion preference checked; not physical browser/device certification. Timeline is deliberately horizontally scrollable on phones; agenda/form remain alternatives. Five-minute cards retain 24px minimum, full accessible labels/details and agenda, not all inline metadata.
- Actual final-source desktop calendar, 320px timetable, 390px agenda and 390px draft screenshots inspected, with earlier connected-calendar/agenda images retained for comparison. Saved E1 evidence: `docs/evidence/e1-calendar-{320,390,768,1024,1440}.png`, `e1-agenda-390.png`, `e1-slot-draft-390.png`. No known text/control overlap in inspected final captures; long timeline names intentionally ellipsize.
- HTTPS preview independently browser-tested: create isolated fictional workspace → updated controls → New booking/availability → Escape close, zero page errors. URL remains `https://3000-iz3aw7n21l3edjgvt4bkj-5c13a017.sandbox.novita.ai/workspace` (temporary sandbox only).
- Parallelism actually used: independent inspection tools, full-suite two-worker tests in isolated tenants, and read-only visual/external-preview verification alongside regression. One coordinated source owner; no coding subagents, schema change, migrations, dependency additions, live providers or deployment. No existing user's records were reset.
- Initial failures were resolved, not omitted: first pointer checks failed due to focus-message movement; first keyboard break test incorrectly assumed a 13:00 break instead of the seeded 12:45. Corrected UI and test fixture expectation before final green runs.

### Next work and remaining gates

Review E1 in the running preview before propagating new presentation patterns. Next enhancement package is **E2: booking/review/detail/reschedule clarity and wider settings/navigation draft protection**, not another E1 planning reset or simultaneous account rewrite. Then E3 team/catalogue/schedules, E4 settings/activity/measured performance, E5 acceptance. Section 13's account/session/permission roadmap remains separate and unimplemented; keep owner capability honestly labelled.

Physical touch/screen-reader/user acceptance, many-barber performance, full week/month and drag/drop remain unproved/unimplemented. Early/backdated completion policy is unchanged and still open. Feature register remains **189 unique requirements: 53 implementing / 136 not_started**, all original 125 C/B/A IDs preserved, no production-verified/accepted rows. E1 concerns A-02/A-12 and existing booking/detail/move/closure/leave/break foundations; these broader requirements are not upgraded merely by local UI regression.

The following sections retain the prior d6cb261 delivery and historical evidence; they are not a second current app or the latest test counts.

## Read this first

**D-014 controls UI continuity: build on the original preview layout/calendar, not the stripped-down workspace. D-012/D-013 retain matte forest/sage colours, persisted functionality and nothing live.** No restart, production deployment, provider activation, real messages/charges/transfers or public GitHub push. This is not the completed 189-feature commercial SaaS.

Main runtime `/workspace` now has an original-style connected day timetable/agenda, dark forest navigation and integrated Team/Services/Settings/Audit. The primary entry is unchanged and existing cookies/data still work. `/preview/*` remain fixture-only references, no longer linked prominently as a competing main app. Customer/barber operational integration and role-specific identity are unfinished. The Accounts section says so explicitly; it does not collect passwords or pretend to authenticate.

## Current delivery — visible calendar and reliability improvements

User requested visible building rather than another planning-only cycle. Actual changes:

1. `src/client/Calendar.tsx`: saved barber-column day timetable, 15-minute clickable draft cells, working-hours/break/leave/closure shading, actual current-time marker, week-date strip and agenda alternative. Staff/time draft prefills only after authoritative service availability allows it; no slot is held by a click.
2. Existing appointment controls are connected to the timetable: create/review/save, open details, immutable service/add-on history, reschedule and status/cancellation. Cancelled/no-show history remains accessible and releases occupied time. New stats use filtered saved records; booked value excludes cancelled/no-show and is explicitly not collected revenue.
3. Main navigation keeps all existing staff/services/add-ons/individual rules/weekly and dated schedules/shop settings/audit available in one app. Forest sidebar and calendar reuse the original style. Accounts is an honest unfinished-access overview, not a login implementation.
4. `GET /api/sandbox/bookings?date=YYYY-MM-DD&limit=200`: complete date-scoped reads with deterministic `(start_at,id)` cursors and optional staff/status filters. The main UI follows every selected-day page, not the legacy 500-row workspace snapshot. Impact warnings now read future active bookings independently; issue details load directly by authorized ID, even outside the selected day/snapshot.
5. Per-service pricing saves keep the editor open and preserve other rows' drafts; success feedback clears when that row is edited again. Shared protected workspace dialogs confirm dirty Escape/backdrop/Close, disallow pending-save close and retain non-destructive editing. General settings/tab navigation and other nested editor-switch policies still need further work.
6. Workspace response checks validate required arrays; a workspace render error boundary provides honest reload/recheck guidance. It never asserts that an interrupted save did not happen.

**Scope honesty:** no customer sign-up/sign-in, real admin/staff accounts, membership permissions, public customer booking, holds/payments/messages, week/month resource calendar, drag/drop or PWA implemented in this slice. Existing owner capability remains unchanged. Accounts/permissions is next, not a fake completed screen.

### Current verification

- First focused run: 13/13 calendar/catalogue tests passed.
- Full run at 13:20:58 UTC: 42 unit/route/domain tests, direct local D1 invariants and **60/60 browser/API tests**, zero failed/skipped/flaky; dependency audit zero vulnerabilities. Report `test-results/runs/1789392058383-53472/results.json` (104.56s).
- **Final run passed on unchanged source:** build → typecheck → 42 unit/route/domain tests → direct D1 invariants → **60/60 browser/API tests** → identical before/after source hash → dependency audit (zero vulnerabilities) → diff check; exit 0. Report `test-results/runs/1789392279064-55106/results.json`, started 2026-09-14 13:24:39 UTC, 106.22s, zero failed/skipped/flaky. Includes the final form-success-feedback refinement. Worker 141.76 kB (42.60 gzip), client JS 507.76 kB (120.57 gzip).
- Six new cases in `tests/calendar.spec.ts`: 503-record complete reads/impact warnings, deterministic cursor ties and tenant/invalid-query checks; click/create/reload/move/cancel flow; multi-row pricing and explicit discard; failed-day/malformed-response recovery; 390/1440 timetable axe/layout/slot checks. Existing catalogue save helper explicitly closes the now-staying-open rule editor; no security/booking tests weakened.
- Existing five-width and original fixture preview regressions passed. Actual populated desktop/calendar and mobile/agenda screenshots captured and inspected: `docs/evidence/connected-calendar-1440.png`, `connected-agenda-390.png`. Slot dialog screenshots from focused run also inspected.
- Public HTTPS development preview was browser-tested: isolated fictional workspace creation and timetable display succeeded. URL: `https://3000-iz3aw7n21l3edjgvt4bkj-5c13a017.sandbox.novita.ai/workspace`. Temporary sandbox service only, not production deployment.
- No migrations/dependencies/provider configuration added. Existing local records retained. New API/UI uses the same tenant, mutation, quote and database collision guards. Preview/test data created only in separate fictional shops.

### Audit resolution status

- AUD-01: main calendar selected-day truncation and missing impact warnings fixed and reproduced regression passed. Legacy `/workspace.bookings` still caps 500 for compatibility; global/date-range search and paginated audit/impact UI are not completed. Impact scan is now complete but still needs measured scale/performance work.
- AUD-02: individual rule saves preserve other dirty drafts, tested.
- AUD-03: workspace dialog Escape/Close/backdrop and pending-save protections implemented; direct in-app navigation/settings and broader transition coverage remain.
- AUD-05: required-array response validation and workspace render boundary implemented; malformed response recovery tested. Full nested response validation remains an improvement.
- AUD-04/06/07/08: timing policy, production identity/abuse, broader architecture/performance and audit-detail work remain as recorded below.

## Historical session — comprehensive enhancement planning, D-015

User asked to enhance/modernise every created feature, ensure correct visual placement and enjoyable customer/admin experiences, explain current feature progress, identify improvements and produce a comprehensive plan. No runtime changes were requested/executed as part of this planning deliverable.

- Rechecked revision/clean tree, original Admin fixture imports, current docs and feature register. Counts unchanged: 189 unique requirements, 53 implementing / 136 not_started; zero production verified/accepted. Re-inspected original committed admin desktop, customer phone and barber phone screenshots for layout continuity; no new screenshots or UI fixes generated.
- **BUILD_PLAN section 12** now contains the current-state matrix, enhancement coverage for every existing area, missing product capabilities, market-informed proposals, sequenced 03A/03B substeps and acceptance/decision dependencies. Earlier architecture, financial model and milestones retained; no new register rows or release-scope changes.
- **DESIGN_SYSTEM** adds an enhancement checklist covering shell/calendar/drawers/directories/forms/customer steps/barber queue/colour/feedback, including dense/empty/error/mobile cases.
- **QUALITY_GATES** adds pending T-ENH-01..11 integration contracts for original-layout continuity, complete calendar reads, saved lifecycle, multi-row drafts, dirty/pending dismissal, render recovery, setup, customer-to-barber flow, time policy, placement/accessibility and performance. These are not executed tests.
- **DECISIONS D-015 and README** reflect this plan and the unchanged runtime split. The original layout remains the product foundation, not the list-only replacement. Keep matte baseline; no new palette, live service, deployment or external publication authorized.
- Immediate execution order: **03A/1a complete queries → 03A/1b original calendar integration → 03A/1c integrated setup/form polish**. Then original customer/barber connected test journeys, holds and gated identity/payment/communications/finance/PWA/SaaS work. Do not respond to the next build instruction with another planning reset.
- Validation for this planning turn: document diff/requirement-ID checks and unchanged runtime files only. Prior 42/54 regression evidence below remains the latest runtime run; no new full suite claimed. AUD-01..08 remain open as documented.

## Completed local functionality

### Existing foundation preserved

- Isolated browser-owned shop with editable example staff/services and no seeded bookings/payments.
- Shop settings, open/closed weekdays, weekly staff hours/breaks, full-day leave and shop holidays.
- Staff/service create/edit/deactivate/reactivate, search, active/inactive filters and affected-appointment warnings.
- Server availability, reviewed/idempotent bookings and walk-ins, per-shop references, day list, search/barber/status filters.
- Versioned contact/notes corrections, same-reference reschedule, check-in/in-service/completed, cancellation and grace-checked no-show. Service completion does not imply payment.
- Append-only attributable audit; optimistic conflict rejection; booking deletion forbidden.
- Network/HTML proxy failures retry in-page. Save success followed by failed read does not repeat the mutation. Lost booking responses replay safely. Stale editors can explicitly discard/load current records.

### WP-LOCAL-02 delivered in this session

1. **Persisted add-ons and service links:** create/edit/deactivate; integer-pence price, 0–120 extra minutes, explicit eligible services. New records do not disappear on reload.
2. **Barber/service rules:** enable/disable eligibility and price/duration overrides. Missing rules inherit catalogue behaviour; null restores defaults, zero price is valid. Disabled coverage blocks new selection/bookings/moves and flags affected future appointments.
3. **Itemized authoritative booking quotes:** service line plus up to ten unique add-ons; exact durations are summed rather than rounded to the start grid. Changing selections clears stale times without losing contact fields. Server quote versions require review after catalogue/rule edits.
4. **Immutable booking-item snapshots:** `bookings.items_json` persists service/add-on names, prices and durations in the same row/write as the interval allocation. Legacy bookings are backfilled to one service line. Catalogue edits, add-on withdrawal and rescheduling never reprice saved history.
5. **Partial-day dated hours:** create/edit/remove a dated replacement shift and break. Weekly hours are replaced, not intersected; shop hours/closures and full-day leave still win. Changes flag impacted appointments; deletion restores weekly hours without deleting bookings.
6. **Admin controls and booking integration:** Services → Add-ons; Team → Services & pricing / Dated hours; New booking → Optional add-ons; saved details show original item lines. Service rules save individually, one section at a time.

## Data, safety and migration contract

- Hono/React/D1 architecture retained; no new runtime dependency or framework replacement.
- `src/server/domain.ts`: strict schemas, `calculateQuote`, `effectiveHours`, London/DST conversion, interval checks and shared types.
- `src/server/sandbox.ts`: existing cookie/Origin/session boundary reused for all new routes. Tenant IDs/prices/totals cannot be supplied as authority. All functional routes require local `APP_MODE=sandbox` plus a DB binding.
- New tables: `addons`, `addon_services`, `staff_service_rules`, `staff_schedule_overrides`; existing shop/staff/schedule/booking/audit tables retained.
- `0004_catalogue_and_dated_hours.sql` is applied locally. The working database was retained. A separate empty local database successfully applied the entire five-file migration chain.
- Earlier files include two distinctly named `0002_*` migrations; do not rename already-applied files. Next migration number is `0005`.
- Add-on/link/rule edits increment `shops.version` in the same transaction. Existing service/shop quote-version checks therefore reject stale review state; no client-authoritative amount was introduced.
- SQLite triggers validate current item sums/pricing/eligibility, dated shifts, leave/closures and interval collisions inside the write. Separate availability reads are feedback, not locks. Snapshot JSON cannot be updated afterward.
- Booking replay hashes omit empty default add-on selections to preserve the earlier normalized payload contract. Only booking creation has request-key idempotency; inspect refreshed records before repeating other interrupted creates.
- No external API calls, production resources or credentials were added. `.dev.vars`, `.wrangler/` and test-results stay ignored.

## Prior WP-LOCAL-02 verification — conclusive result

Final command: build → typecheck → unit tests → direct D1 invariants → complete Playwright suite → unchanged-source hash check → dependency audit → diff check. Exit code **0**.

| Check | Result / evidence |
| --- | --- |
| Build / TypeScript | Passed |
| Unit/route/domain | **42 passed**: 23 preview and 19 domain/boundary tests |
| Direct local D1 | Passed raw-write overlap, quote/item totals, add-on/rule eligibility, partial-day shift, immutable history, batch rollback, leave/closure and no-show checks |
| Full browser/API suite | **54 passed; 0 failed/skipped/flaky**, `test-results/runs/1789389389665-42361/results.json`; start 2026-09-14 12:36:29 UTC; 80.44 seconds |
| Stable source | Source/assets/tests/migrations had identical aggregate SHA-256 before/after final build and full regression; command printed `VERIFIED: final source remained unchanged through full regression.` |
| Mutation coverage | All **21** POST/PUT/PATCH/DELETE routes included in source-derived inventory; Origin/session/invalid-input checks passed |
| Catalogue persistence / history | Add-ons, service links, overrides, rules, booking items and edits survive reads/reloads; old itemized commercial values retained |
| Conflicts | Six simultaneous aggregate-duration bookings: one winner, five conflicts; buffer boundary, stale quote, disabled coverage, reschedule rejection/rollback and partial-day limits tested |
| Recovery regression | Existing initial-load/proxy/read-after-save/lost-booking-response/stale-editor tests passed; new add-on slot/price conflict recovery preserves contact fields |
| Accessibility/layout | Existing five viewport regressions passed; new forms passed axe scans at 390/1440 px. New mobile add-on/rules and desktop dated-hours screenshots inspected: readable/no clipping or overlap |
| Migration bootstrap | All five migrations passed on separate empty local DB; no remote operations |
| Dependency audit | Zero reported vulnerabilities |
| Secret exclusion | Local vars, databases and generated traces ignored |

New tests: `tests/catalogue.spec.ts` (7 API/browser/visual cases); expanded `tests/domain.test.ts`, `tests/d1-invariants.mjs` and mutation inventory in `tests/sandbox.spec.ts`. Original preview and saved/reload workflows remain covered.

Resolved test issues, not hidden failures:
- A raw stale-quote test also had an active closure and depended on SQLite trigger ordering. The test now removes the closure before isolating quote rejection; both guards still have independent assertions.
- Playwright's option-enabled matcher reported an explicitly disabled native `<option>` as enabled. The test now asserts its actual DOM `disabled` property; server conflict checks remain independently tested.

Screenshots committed under `docs/evidence/catalogue-{addon-form,barber-rules,dated-hours}-{390,1440}.png`. Per-run screenshots/traces remain isolated under test-results. Do not build/migrate or reuse artifact run IDs during a running suite. Automated axe/Chromium checks are not real-device or full WCAG certification.

## Feature and milestone tracking

All **189 rows and 125 original C/B/A IDs remain intact**. **53 rows are `implementing`**, not production `verified`/`accepted`; 136 remain `not_started`. Current additions: C-02/C-03/A-19/A-20/A-21, with shared availability/buffer/A-28 work extended. A-14 now correctly reflects previously implemented local full-day leave. Native/v1.5 scope is not silently changed; B-06/B-07 remain deferred role-specific work.

M1/M2/M3/M5 are in progress: local persistence, catalogue, allocator and service transitions have evidence, but production identity, public/customer/barber integration, holds, payments and PWA gates remain incomplete. M4/M6/M7/M8/M9 are not delivered by this slice.

## Overall-product audit — 2026-09-14, baseline c1350a4

User requested an honest whole-app assessment and improvements towards a market-leading product. Scope: code, all 189 feature rows, migrations/test architecture, focused local API/browser experiments, actual 390/1440 screenshots and a limited official-vendor feature comparison. No application code, schema, feature status or approved commercial policy changed. This is not a security certification, production load benchmark or competitive usability study.

### Readiness by product area

| Area | Actual position | Main gap |
| --- | --- | --- |
| Owner setup/catalogue | Persisted local CRUD, eligibility, exact pricing, weekly/dated hours | Production membership/permissions, complete setup/onboarding, images, final policy |
| Booking engine | Strong local write-time guards, snapshots, replay, reschedules/status | Complete reads/issues, holds/expiry, public integration, final time policies |
| Owner daily UI | Persisted day list and controls; fixture resource-calendar proof | Connected day/week/month calendar, safe drafts, full search/issue navigation |
| Customer journey | Fixture preview plus shared backend capabilities | Public shop links, persisted end-to-end flow, secure customer identity/history |
| Barber journey | Fixture queue plus owner-operated status APIs | Assigned-role access, connected queue, customer history, checkout/earnings |
| Payments/finances | Model A design only; no money collected | Test-provider account proof, collections/refunds, ledger, cash/tips, receipts and manual pay-runs |
| Communications/reviews | Planned | Durable outbox, real scheduler, delivery recovery, consent and verified reviews |
| PWA | Responsive browser UI only | Manifest/install/update, restricted offline cache, logout purge and device/push tests |
| SaaS/security/operations | Local capability isolation tested | Managed identity, MFA/invites/revocation, subscriptions/entitlements, platform console, privacy and restore/monitoring |

Register recount: customer 12 implementing / 34 not_started; barber 6 / 26; admin 23 / 24; SaaS 3 / 17; other acceptance/quality/notification/roadmap/integration rows 9 / 35. Total 53 / 136. Do not convert this into a completion percentage: implementing is partial, requirements differ in size, and some share the same foundation. No production verified/accepted rows. Preserve all original scope decisions.

### Findings as reproduced during the audit — see current resolution status above

| ID / priority | Evidence and impact | Required improvement |
| --- | --- | --- |
| AUD-01 / high, next slice | `sandbox.ts:294–338`: 503 valid API-created appointments in a new isolated shop returned only 500. Earliest appointment disappeared from list AND leave-impact warnings, but direct detail still returned it. Availability correctly returned day-off. This is read/operational visibility failure, not deletion or demonstrated overbooking. | Server-side date/status/staff/search queries with deterministic cursor `(start_at,id)`; separate complete impact/summary queries; independently paginated audit history. Never merely increase LIMIT. |
| AUD-02 / medium, next slice | Browser: edit Signature cut to £33 and Skin fade to £39; save Signature cut. Dialog closes; reopening shows £33 retained, Skin fade blank. Named save is correct for one record but silently discards another dirty section. | Keep dialog open and preserve other drafts after per-section save, or deliberately implement atomic save-all; test multi-section and stale-version behaviour. |
| AUD-03 / medium, next slice | Browser: edit Skin fade to £41, press Escape, reopen: blank without confirmation. `ui.tsx:262–276` also wires backdrop/Close directly to dismissal; only Escape was reproduced. | Shared dirty-state confirmation for Escape/Close/backdrop/navigation, plus pending-mutation dismissal policy. Do not blindly persist private drafts to localStorage. |
| AUD-04 / policy risk, before finance | API: appointment on 2026-10-05 passed CHECKED_IN → IN_SERVICE → COMPLETED on 2026-09-14, without an override reason. No-show alone has a time guard. | Agree permitted early/backdated transitions and privileged corrections; enforce server-side and audit reason. Do not arbitrarily ban legitimate early arrivals. Completion must not make premature pay-run eligibility. |
| AUD-05 / medium, next slice | Synthetic response fault: replacing workspace `staff` with null produced `Cannot read properties of null (reading 'filter')`, empty root and no recovery UI. `main.tsx:75–76` renders Workspace outside the preview error boundary. No actual corrupt D1 response was observed or created. | Workspace-specific render boundary and validated response shape; preserve honest ambiguous-save wording and offer recovery without claiming nothing was saved. |

**AUD-01 reproduction details:** POST `/session`; use the default 30-minute service and two staff; create 503 future bookings across non-Sundays, starting two days ahead, at 540/585/630/675/720/810/855/900/945/990/1035 local minutes, with fresh request IDs and current quote versions. Add day off for the first booking's barber/date, GET workspace, GET first booking by ID, GET availability. Confirm 500 list entries, first ID absent from list/issues, detail exists, slot reason day off. Successful audit shop `73bd29b7-fad5-4fe7-9528-dd4831fc3903`, first booking `9c6e5640-1e96-49b9-8c74-9e5aa69bcaaf`, date 2026-09-16. An initial 501-row attempt did not establish omission of the chosen ID because two staff shared the earliest start; 503 removed that tie ambiguity. Both fictional shops remain locally; no triggers disabled or existing shops altered. Future regression should use an injected/fixed clock where applicable and assert desired complete results, not codify this defect.

AUD-02/03 screenshots: `test-results/audit-rules-390.png` and `test-results/audit-rules-1440.png`, generated and visually inspected. Matte styling remains coherent, labels readable, no observed horizontal clipping in these views. The long multi-service dialog is scroll-heavy; separate per-rule saves are easy to misunderstand. These ignored screenshots and inline audit probes are not new permanent passing regression tests. Normal UI probe had zero page errors; AUD-05 intentionally triggered one. Add permanent tests when fixing each issue.

### Code-inspected engineering/release gaps

- **AUD-06 — production access and abuse boundary:** current seven-day browser capability is intentionally owner-only. No managed memberships, logout/revocation/recovery or rate limiter. Input has a 16,384-character check, but only after reading the full body; add byte/stream limits before expensive parsing plus endpoint-specific abuse controls before public exposure. Existing Origin, tenant scoping, hashed cookie and CSP protections are real but not production authentication.
- **AUD-07 — maintainability/performance:** Workspace is 2,229 lines, sandbox router 1,193. Extract API/recovery, queries and feature editors incrementally; retain shared domain rules and DB guards. All preview components are eagerly imported into the same client entry. Consider route splitting and measured payload/API budgets before growth, not a framework rewrite. Local timings are not edge-load evidence.
- **AUD-08 — traceability and recovery:** audits are append-only but generic catalogue edits do not retain reconstructable before/after values. Add privacy-safe changed-field metadata and correlation IDs, export/pagination and operational issue ownership. Only booking creates have payload-bound replay: add idempotency systematically before introducing financial/delivery side effects. A health endpoint showing configured persistence is not a DB restore or readiness test.
- Customer identity should use stable customer IDs and consent/access grants before portal/history; do not interpret shared phone numbers as unique persons. This does not silently pull the deferred full CRM-merge UI into MVP.
- Sensitive notes need minimization/retention/access review, including how immutable historical records support lawful pseudonymization. Never load owner-wide data into a barber/customer UI and hide fields client-side.
- No actual provider, Safari/Firefox, physical device, load, screen-reader, penetration or restore acceptance was performed. Region-specific Stripe/Terminal availability and native/PWA promises remain separate gates.

### Market/quality assessment

A limited check of official SQUIRE, Booksy and Fresha pages found waitlists, reminders/no-show protection, connected checkout, client history and reporting promoted as mainstream capabilities. See BUILD_PLAN audit section for dated links and proposed additions. This is advertised feature evidence, not a tested ranking or verification of vendor performance claims. Our opportunity is a fast, dependable barber-specific working day and exceptionally clear Model A finances—not simply more screens or AI-labelled controls. No new scope or financial model approved by this comparison.

### Audit verification

The prior audit completed `npm test` and `npm audit --audit-level=high` successfully: 42 unit/route/domain tests, direct D1 checks, 54 browser/API tests, zero reported dependency vulnerabilities. Report `test-results/runs/1789390332489-47050/results.json`, started 2026-09-14 12:52:12 UTC, duration 80.27 seconds, zero failed/skipped/flaky; report re-read during this clarification turn. `npm run build` also passed after the suite. Runtime sources/migrations/tests remained at c1350a4; audit notes were auto-backed up in 05599ae before this clarification. No new runtime tests or migrations were run for this documentation-only direction change. Earlier migration bootstrap evidence belongs to WP-LOCAL-02.

## Original WP-LOCAL-03A checklist — connected calendar slice now delivered

The first visible calendar integration is implemented above. Do not rebuild it. Remaining checklist obligations stay tracked; BUILD_PLAN section 13 defines the newly prioritized WP-LOCAL-04 accounts/permissions work requested by the user.

0. **D-014 visible goal:** reuse the original admin shell, navigation, resource calendar, date/barber controls and mobile agenda, connecting them to persisted appointments and existing create/detail/reschedule/status APIs. Integrate setup/catalogue/team/schedule functionality into that same interface. Preserve backend/data/tests; no second replacement design or cosmetic redirect to fixture-only screens. Compare actual before/after screenshots at desktop/tablet/phone sizes before calling the consolidation complete.
1. Fix AUD-01 with tenant-scoped server date/status/barber/search/cursor reads and admin pagination; separate complete impact/summary reads and paginate audit. Prove >500 records, tied timestamps, no cross-shop access and no disappearing near-term appointments.
2. Fix AUD-02/03/05: preserve multi-section drafts, confirm dirty dismissal, define pending-save closure, and add workspace render recovery/response validation. Reproduce failures first as focused tests; retain all existing regression cases.
3. Extract only the query/API/editor boundaries needed for those fixes. No broad refactor, recolour or new framework.
4. Follow with WP-LOCAL-03B: connect customer and assigned-barber **test** journeys through least-data shared APIs with explicit local test grants/labels, not owner-cookie role impersonation or reused fixture authority. Include customer → owner → barber → completed visit and failure/reload workflows.
5. Follow with separately bounded WP-LOCAL-03C holds/expiry/late-confirmation proof before payment-dependent flows. Resolve AUD-04/O-09 time policy before financial eligibility.
6. Production identity, memberships/invites/MFA and customer verification remain explicit gates; develop their authorization contracts alongside test surfaces. Provider activation and deployment stay paused. Keep the persistent handoff; do not restart planning.

## Limits and operations

- London timezone; exact duration + ten-minute buffer; one dated shift/break per barber/date. Multiple split shifts, overnight work and arbitrary multi-zone support are not implemented.
- Add-ons/service rules are owner-test controls, not production staff self-management. Rules save per service. Deleted dated overrides retain audit, not a restorable version-history UI.
- Legacy workspace snapshot retains 500 bookings and 200 audit events. The main timetable uses complete paginated day reads instead, and impact warnings are evaluated independently. Date-range/global search, audit pagination and measured impact-scan scalability remain unfinished.
- Seven-day capability session, no account recovery/logout management or automatic old-test cleanup. Use fictional records only; no private offline cache/write queue.
- No customer portal, public shop routing, financial ledger/cash/tips/refunds/receipts/pay-runs, reviews, messaging, subscriptions/platform console or installed/offline PWA.
- Model A unchanged: shop receives customer money; owners segregate and pay barbers externally. No wallet, bank transfer execution or live payment claims.

## Service and continuity

PM2 `barbershop-preview`, port 3000, `http://localhost:3000/workspace`; health reports local-sandbox/persistence true/livePayments false. Temporary development Preview only; no production URL.

Selected GitHub repository remains https://github.com/BreezeCreative26/NEW-Barber-System-App-PRoject, previously public/empty. No push or visibility change authorized/performed. Recheck and obtain publication consent before syncing. Preserve local/genspark history.

Next session: read AGENTS, this handoff, DECISIONS, actual schema/tests and git status. Continue from this tested slice. No production action unless the user explicitly changes the instruction.

## 2026-09-14 — Timetable rebuilt to the OLLO shell design

- **One-row toolbar** (`.calendar-toolbar-row`): Today · ‹ date › (native date picker under a compact label) · Barber select · **Filters** toggle (`data-testid="filters-toggle"`, reveals Status filter + Search appointments + Clear filters) · Refresh · Day/Week/Agenda segmented · New booking. Phone: wraps to two rows, icon-only Add, full-width view switch.
- **Day stats** collapsed from four stat cards into a one-line summary (`.calendar-summary`, `aria-label="Selected day statistics"`): booked value · completed/visits · online · % chair time.
- **Waitlist + schedule issues moved into a Notifications drawer** (`data-testid="notifications"`, bell count = issues + waitlist). Waitlist heading, "Book them in" and "Close" behave as before. Escape / scrim / close button dismiss.
- **Timetable on mobile**: day view is now the default at every width; `useCompact()` narrows columns (150px) and gutter (44px) below 768px and the board scrolls sideways inside its own region. Column heads show `£taken · N visits`; events show service · price and `BlockIcons` (online / standing / walk-in).
- Legend + keyboard help folded into `.calendar-foot` (help is a `<details>`); cancelled/no-show history is a collapsible `<details>` with a count.
- Page heading removed on Appointments (visually-hidden h1 + h2 "Your timetable" kept for AT/tests); other tabs unchanged.
- Tests: new helpers `openFilters(page)` / `openNotifications(page)` in `tests/fixture.ts`; calendar/workspace/accounts/public specs updated; visual baselines refreshed deliberately (5/5).
- Gate: tsc OK · guardrails PASS · vitest 26 · Playwright 103 passed / 1 flaky (`workspace.spec.ts:594` strict-mode clash on two "Reason" textareas in the appointment panel — pre-existing panel markup, passed on re-run twice; to be tightened with an exact label).

## 2026-09-15 — Payments ledger, checkout and shop wallet (Model A)

- **Migration 0011** `payments` table (append-only; void sets `voided_at` once; triggers refuse edits/deletes and any row against a visit that is not IN_SERVICE/COMPLETED). `staff.commission_pct` (default 50), `shops.till_access` ('OWNER' | 'ALL').
- **Routes**: `POST /bookings/:id/checkout` (tenders[] × method/service/tip, discount, `complete` flag; guards: due amount, over/short payment, version), `POST /payments/:id/void` (owner/manager, reason ≥3), `GET /wallet?from&to` (totals, by method, by barber incl. commission snapshot + tips, unpaid booked value, recent rows). `/workspace` now returns `payments` (last 120 days). Barber accounts see only their own rows.
- **Checkout** (`src/client/Checkout.tsx`) inside the appointment panel: price → discount → tip chips (£0/2/3/5/other) → method tiles (Card/Cash/Transfer/Voucher) → "Record £x · complete"; optional split (part payments leave the visit IN_SERVICE). "Complete unpaid" remains for cash-free finishes. Paid strip under the items list with Void (owner/manager).
- **Wallet drawer** (`src/client/Wallet.tsx`) from the top-bar wallet chip: Today / This week / This month; hero (services · tips · booked-unpaid), method tiles, by-barber KPIs with what the shop owes each (commission % + tips), recent payments (click → appointment). Barber accounts get "My earnings" (commission, tips) instead. Wallet chip = ledger recorded today, not bookings.
- **Settings**: Shop → "Who can take payment" (shop device only / barbers for their own visits). Barber profile → "Commission on services (%)". Demo seeds Jay 60 / Marcus 50 / Dani 55 and a ledger row for every completed visit.
- Timetable events show the `paid` block icon once a live payment exists.
- Tests: `tests/payments.spec.ts` (3: UI checkout→wallet→void; server guards incl. split/over/short/stale; till access for barbers + owner setting). `sandbox.spec.ts` mutation contracts extended. Fixes along the way: series strip cancelled tiles AA contrast; panel keeps focus after saves; `workspace.spec.ts:594` locator tightened + 31-day range cap respected.
- Gate: tsc OK · guardrails PASS · vitest 26 · Playwright 106 passed / 1 flaky (`workspace.spec.ts:184` stale-editor; passes 2/2 in isolation) · visual baselines refreshed (phone calendar).
- Defaults chosen pending your call: commission per-barber % on services + 100% tips; till owner/manager-only.
