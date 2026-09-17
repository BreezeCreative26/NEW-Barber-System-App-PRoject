# OLLO UX standard

The bar: a barber who has used Fresha, Squire or Square Appointments should find OLLO at least as
polished, and never notice it was built by a small team. Every screen shipped from now on is held to
this list. `npm run ux:lint` enforces the parts that can be checked mechanically; the rest is
reviewed against the screenshots produced by `node scripts/audit/ux-review.mjs`.

## 1. Live, not refreshed
- The workspace re-reads on focus, on visibility change, and on a timer (20s on calendar views,
  60s elsewhere). There is no Refresh button anywhere in the product.
- Polling never interrupts a dirty form, an open dialog or an in-flight save.

## 2. Open on what matters
- The calendar opens scrolled to *now* (today) or to the first appointment (other days). Nobody
  should ever land on empty morning hatching.
- Lists open on the most useful item first (next appointment, most recent customer).

## 3. Language a barber would use
- No engineering, roadmap or harness words in any user-facing string: "build", "sandbox",
  "fixture", "harness", "provider", "planned", "later", "todo", "placeholder", "coming soon",
  "not yet", "in this build", "docs/", "plan".
- Section headers say what the page is *for* in one line, or say nothing. No generic
  "Manage your shop" filler. No `YOUR SHOP /` breadcrumbs.
- Collapsible sections are labelled by what they do ("More actions"), not by their contents.
- Money always goes through `money()` / `currencySymbol()`; never a hard-coded `£`.
- Times and dates respect the shop's timezone; the calendar gutter shows the real zone (BST, CET…).

## 4. One way to do a thing
- One primary action per screen. On phones the tab-bar `+` is *the* add control; the toolbar
  copy of it is hidden.
- The same accessible name for the same action everywhere ("New booking").

## 5. Density and chrome
- Phone: the calendar grid must start within ~330px of the top of the viewport. Toolbar is two
  rows maximum. Stats collapse to a single line.
- Desktop: cards, not tables, for browsing; tables only for numeric comparison (Pay, Insights).
- Empty states explain and offer the first action; they never look like an error.

## 6. Status reads at a glance
- Roster cards show live state ("3 visits · £65 today · Next 14:00", "Free today", "Off today"),
  never bare zeros.
- Appointment cards show customer, service, price, status. Buffers and breaks are visible but quiet.

## 7. Accessible by default
- Every interactive element has a name. Dialogs trap focus and return it. Axe passes at 320, 390,
  768, 1024 and 1440 (enforced in `tests/workspace.spec.ts`).

## 8. Honesty
- Never describe a feature the customer can't use. If deposits aren't taken online, say
  "payable in the shop" — not "not collected in this build".
- Settings shows what the owner can *do*, not what we plan to build.

## Gate
- `npm run ux:lint` — user-facing copy scan (fails on the banned list above; allowlist in
  `scripts/ux-lint.mjs` for legitimate uses).
- `node scripts/audit/ux-review.mjs` — seeds a realistic shop and screenshots every surface to
  `/tmp/ux/` at 1440 and 390. Review before merging visual changes.
- Playwright visual baselines in `tests/__screenshots__` are refreshed only for intentional changes.
