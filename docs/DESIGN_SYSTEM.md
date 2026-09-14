# Barbershop OS — UI/UX design contract

Version 1.1 · 2026-09-14 · User direction confirmed in D-011: clean modern visuals, teal secondary accent and rounded edges. Revised tokens and compositions await implementation/review; existing screenshots show the earlier green/sage preview.

## 1. Definition of excellent design

The product must feel deliberately composed, calm, fast and trustworthy. Premium means the right information and action at the right moment, readable hierarchy and precise behaviour—not excessive animation, decorative charts or dozens of cards.

- Customer: book confidently with minimal effort and no surprise charges.
- Barber: identify the next customer and perform the correct action with minimal taps.
- Owner: see today's operations, identify exceptions and reconcile money without interpretation.
- Platform operator: manage tenants without accidental access to private customer data.

A beautiful nonfunctional screen fails. A working screen with unusable placement also fails. Design approval and functional proof are both required.

The assistant cannot permanently retrain itself. These files are the repeatable project method: read, design, implement, inspect, test and record. Never claim that a skill, a design approval or a test has occurred when it has not.

## 2. Visual direction: clean modern product, teal secondary accent

The user has specified the direction. Do not ask them to repeat it or block work on references. Keep a predominantly neutral visual foundation, charcoal primary hierarchy and teal as a secondary brand accent. Teal is not a mandate to paint every card or large background green. Do not clone a competitor's branding or import unlicensed imagery.

Implementation target: contemporary, restrained SaaS interface with a mobile-app feel—not rustic, vintage or sage-dominated. Replace the current forest/sage/olive-heavy colour treatment through semantic tokens. Reduce decorative stamp artwork and serif-led hero styling; preserve useful screen structure and all working interactions.

### Proposed tokens

| Token | Initial proposal | Usage |
| --- | --- | --- |
| canvas | `#F7F9FC` | Clean cool-neutral application background |
| surface | `#FFFFFF` | Forms, content surfaces, overlays |
| surface-subtle | `#F0F3F6` | Neutral grouping and low emphasis |
| text-primary | `#182230` | Charcoal headings and primary content |
| text-secondary | `#5D6878` | Readable neutral descriptions and labels |
| border | `#E4E7EC` | Nonessential separators; not sole control boundary |
| control-border | `#8793A2` | Input boundary where contrast requires it |
| action-primary | `#182230` | Strong default primary button on neutral layouts |
| accent | `#0F766E` | Secondary teal brand accent: active navigation, selected dates, links and focused details |
| accent-hover | `#115E59` | Teal hover/pressed state |
| accent-soft | `#E6F4F1` | Pale teal selected backgrounds, used sparingly |
| warning-text | `#855400` | Warning text; validate chosen background |
| warning-bg | `#FFF3D7` | Pending/offline warning surface |
| danger | `#B42335` | Errors and destructive controls |
| focus | `#0F766E` | Teal focus ring with contrasting offset |

Exact hex values are proposed implementation tokens, not separately user-approved swatches. Measure all rendered combinations before acceptance. Neutral/charcoal is the foundation; teal is the single secondary brand colour. Primary-action hierarchy may use charcoal or a deliberate teal emphasis, but ordinary secondary buttons remain neutral/outlined—brand colour and button priority are different concepts. Semantic warning/error colours are permitted. Shop branding must not break contrast.

### Typography

- Proposed licensed sans-serif: self-hosted Inter Variable, with system sans fallback. Confirm font licensing and include only required weights.
- Display heading: 30–32 px desktop / 26–28 px mobile, restrained tracking.
- Section heading: 20–22 px. Body/input: 16 px mobile, 14–16 px dense desktop contexts.
- Supporting labels: 12–13 px minimum target for useful product text; never rely on the earlier preview's 6–10 px metadata for essential information. Body/actions generally 14–16 px. Core appointment/financial values must remain comfortably readable on phone and tablet.
- Body line-height approximately 1.45–1.6; short headings approximately 1.2–1.3.
- Tabular numerals for prices, dates, times and balances. Currency and decimals align in finance tables.
- Dates read `Mon, 14 Sep`; times respect shop locale but display explicit shop timezone where ambiguity matters.
- Avoid ALL CAPS paragraphs, faux-bold weights, tiny grey labels and inconsistent sentence case.

### Spacing and shape

- Base spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 40 / 48 px.
- Inputs and primary buttons: generally 44–48 px tall. Touch areas target at least 44 x 44 px; never rely on a 16 px icon's pixels as its whole hit area.
- Consistent proposed radii: buttons/inputs 12 px; cards 16 px; dialogs and large sheets 20 px. Status chips may be fully rounded. Keep calendar events compact with a smaller documented radius; do not make every control a pill.
- Shadows indicate elevation only: overlays, floating controls and sticky edges. Prefer borders and spacing for ordinary hierarchy.
- Use a consistent 20–24 px outline icon set with matching stroke. Icons supplement text; icon-only controls need accessible names and tooltips where appropriate.
- Avoid emoji UI, unrelated hero photography in admin, animated revenue counters and gradient decoration without a task purpose.

## 3. Layout contracts

### Desktop admin: baseline 1440 x 900

- Sidebar approximately 232–248 px; shop identity at top, main groups in middle, account/help at bottom.
- Header approximately 64–72 px, with page title/context and a small number of useful controls. Never add decorative search/notification buttons without functionality.
- Main padding 24–32 px. Reading/settings content max-width around 1120–1280 px; calendar may use full remaining width.
- Page title and primary CTA share a clear action row. One dominant primary action per task context.
- Overview: compact KPI strip; today's operations as primary surface; narrow action-required/next-appointments column where space allows. No generic collection of equal-weight cards.
- Tables align headers and values, right-align numeric amounts, keep actions stable at row end and define pagination/loading/empty states.
- Calendar: fixed time gutter, clearly named barber columns, current-time marker, visible selected date, predictable toolbar.
- Desktop detail drawer target 420–480 px; use a dialog only when the interaction benefits from a blocking decision.

### Tablet: baseline 1024 and 768 px

- Collapse sidebar to a real accessible navigation drawer or compact rail when necessary; do not squeeze calendar columns into unreadability.
- Preserve large touch targets and clear staff/date filtering.
- Finance tables can use deliberate contained horizontal scrolling with visible headers, or mobile summaries; never entire-page horizontal overflow.
- Detail panels become full-height sheets when two-column layout is too narrow.

### Customer phone: baseline 390 x 844; also 320 px

- 16–20 px side padding; stable progress indicator; clear back navigation.
- Service card: name/description left, price and selection aligned; 56 x 56 thumbnail only if useful and consistent.
- Barber choice: identity, eligible price and availability readable without opening a second screen.
- Date strip and slot grid: selected state visibly different from available/disabled; disabled slots have a reason where useful.
- Checkout summary groups service, add-ons, total, deposit today and remainder. Cancellation policy before payment.
- Sticky bottom action inside safe-area padding; scroll content has enough bottom padding that the last field/error is never obscured.
- Mobile keyboard must not hide the active input or force payment submission accidentally.
- Step changes preserve legitimate form state; invalid downstream choices are explicitly rechecked.

### Barber phone / PWA

- Bottom navigation: Today, Earnings, Profile. Labels remain visible.
- Queue prioritizes time, customer, service, status and next action. A whole-row tap opens details; it never silently marks a no-show.
- Primary operational action is contextual and explicit: Check in, Start service, Take payment, Complete.
- Connection and last-sync status are present without dominating the queue.
- Cash/card controls are separated, visually labelled and recoverable. Offline cache does not imply offline card capture.
- Interruption recovery after lock/unlock or navigation must recheck server state before retrying mutations.

### Platform console

Visually differentiate platform context from shop context. Show current access scope and require explicit audited entry into support actions. A shop-switcher is not authorization.

## 4. Next refinement pass: WP-001-A-R1

Do not rebuild the three routes. Refine the shared visual layer, then resume backend work.

1. Consolidate hard-coded green/olive/beige colours into the neutral/charcoal/teal semantic tokens above.
2. Rework the dark forest sidebar and large green hero/current-chair surfaces into neutral/charcoal foundations with controlled teal highlights; use whitespace and hierarchy rather than colour volume.
3. Apply the radius scale consistently to cards, forms, controls, menus and dialogs; use soft elevation only where needed.
4. Increase undersized text and touch targets; check calendar density without hiding key information.
5. Simplify decorative shop seal/hero treatments for a modern product aesthetic. No new external imagery is required.
6. Preserve all implemented filters, forms, keyboard handling, responsive agenda and fixed mobile booking action.
7. Capture before/after screens on all three surfaces and run the complete existing regression suite plus contrast checks. Existing passing tests do not automatically certify the revised theme.
8. Obtain focused visual feedback, then proceed to scheduling/auth/persistence; avoid open-ended cosmetic iteration.

### Design before broad implementation

M1 proves three representative screens: customer slot selection, admin day calendar, barber queue. Use realistic content: long names, different durations, no availability, payments pending and offline state.

For each screen, prepare:

1. Primary user/job and entry/exit paths.
2. Content hierarchy and layout sketch.
3. Desktop/mobile compositions as appropriate.
4. Default, loading, empty, error, pending, offline and forbidden variants.
5. Every control's interaction contract.
6. Keyboard/focus path and screen-reader labels.
7. Actual browser screenshots at the required sizes.
8. User review record and any deviations from tokens.

Only after this proof should the patterns be spread to all screens. Do not author every screen and then discover the calendar, touch targets or payment layout do not work.

## 5. Shared component catalogue

Build minimal reusable components with demonstrated states, not a speculative enormous component library.

| Family | Components | Required behaviours |
| --- | --- | --- |
| Shell | AdminShell, BarberShell, BookingShell, PageHeader | Landmarks, responsive nav, current context, safe areas |
| Actions | Button, IconButton, ButtonGroup, ConfirmDialog | Disabled reason, pending, destructive distinction, focus |
| Forms | TextField, PhoneField, MoneyField, Select, Checkbox, Switch, FieldError | Labels, help, server errors, limits, dirty state |
| Feedback | Banner, InlineAlert, Toast, Skeleton, EmptyState | Live regions where needed, retry, no fake success |
| Data | Stat, Table, Pagination, FilterBar, SearchInput | Honest metric definition, debounced search, no-match state |
| Booking | ServiceCard, BarberCard, DateStrip, SlotButton, BookingSummary | Selection semantics, live validation, price/time updates |
| Operations | BookingRow, StatusBadge, DetailDrawer, CalendarEvent | Role-based actions, keyboard alternatives, state consistency |
| Finance | MoneyBreakdown, TransactionRow, PayRunPreview, ManualPaymentForm | Exact amounts, frozen totals, manual-vs-bank-confirmed labels |
| PWA | InstallHelp, ConnectionBanner, UpdatePrompt | Capability detection, privacy and interruption-safe refresh |

Use semantic HTML and stable test identifiers reflecting purpose. Do not use clickable divs where buttons/links are appropriate.

## 6. Every control has a contract

Before a control is shipped, record this in the feature's work package or test specification:

- Feature ID, screen, label and purpose.
- Who can see it and who may execute it (server enforced).
- Enabled/disabled/pending conditions and explanation.
- Destination or API command, validated inputs and side effects.
- Confirmation level, especially refunds, deactivation and recorded bank payments.
- Success, failure, timeout and retry behaviour.
- Persistence and navigation/back behaviour.
- Keyboard, focus, screen-reader and mobile touch expectations.
- Test IDs and evidence.

Examples:

| Control | Contract |
| --- | --- |
| Continue to payment | Revalidate quote and reservation; show hold countdown; blocked if shop payment capability absent; preserve details on failure |
| Reschedule | Show proposed time/price changes; require confirmation; acquire new allocation atomically; preserve original on conflict |
| Record bank payment | Owner only; state that no money will be sent; require amount/date/reference; create audited idempotent record |
| Retry payment | First inspect existing attempt; no duplicate charge after a network timeout |
| Deactivate barber | List future appointment impact; confirm; revoke access and stop new selection without deleting history |
| Export CSV | Authorized tenant/period; visible pending state; safe filename/content; formula escaping; no fake download |

A decorative bell, nonfunctional search field, inactive tab, empty menu item or button that only produces a toast is not acceptable. In an isolated design preview, fixtures and nonproduction controls must be explicitly labelled; no real provider success may be simulated as live.

## 7. State and feedback system

- Loading: retain layout and useful cached content where safe; skeleton only for unknown content.
- Empty: distinguish first use, no results, no availability and permission-limited records. Offer the relevant next action.
- Offline: show last sync and limitation; retain only approved cached data; disable actions requiring a live decision.
- Validation error: next to field plus summary for lengthy forms; focus first invalid field; preserve entered data.
- Conflict: explain changed availability and present alternatives, not generic failure.
- Pending payment: do not invite a second payment; offer safe status refresh.
- Success: describe actual outcome, not just “Done”. Distinguish refund requested from refund completed.
- Forbidden/revoked: no stale data exposure; explain session/access recovery without leaking another tenant's existence.
- Destructive action: specific consequence, cancel path, reason when required. Do not default keyboard focus to destructive confirmation.
- Toasts are supplementary feedback, not the only place important errors or financial status appear.

## 8. Accessibility and content

Target WCAG 2.2 AA; automated checks alone do not prove conformance.

- Text contrast at least 4.5:1 for ordinary text; 3:1 for qualifying large text. Relevant control/focus graphics meet applicable contrast criteria.
- Visible focus, logical tab order, keyboard-operable menus/dialogs, trapped modal focus and return to invoker.
- Associate errors and help with inputs; label icon buttons and switches; announce meaningful async outcomes without noisy repeated announcements.
- Selected states use shape/text/icon plus colour. Status badges use meaningful words.
- Calendar drag/drop always has an equivalent form/keyboard operation.
- Support 200% zoom, reduced motion and long text without clipping core actions.
- Use plain language: “£5 due today”, “£35 remaining”, “Recorded paid by owner”. Avoid “Wallet balance” under Model A.
- Booking reference is never proof of identity; never reveal a full phone/email in public errors.
- Dates, prices, tips and fee allocation must not rely on tooltip-only explanations.

## 9. Motion, imagery and performance

- Motion generally 120–200 ms and functional; honour `prefers-reduced-motion`.
- No layout shifts when icons/fonts/avatars load; reserve dimensions.
- Use authorized owner uploads or license-appropriate sourced images. Generated images require user consent before paid generation.
- Route-split calendar and reporting code; optimize font weights/images; avoid heavyweight animation packages for simple transitions.
- Targets to measure at p75 when field data exists: LCP <=2.5 s, INP <=200 ms, CLS <=0.1. Before pilot use representative lab runs and state that they are lab results.
- Initial booking route target <=200 KB compressed first-party JS, reviewed if Stripe SDK load affects the checkout route. Measure separately rather than hiding third-party cost.
- Slot API provisional target p95 <=500 ms under agreed pilot load; define dataset/concurrency and report actual results.

## 10. Review rubric and approval

Score 1–5 for hierarchy, spacing/alignment, typography, component consistency, content clarity, responsive behaviour, accessibility and interaction completeness. Target >=4 per category, with no blocking issue. A score is review judgement, not a substitute for tests.

Before user review: inspect screenshots at intended sizes, open every menu/sheet, trigger errors, tab through forms and test long content. Do not ask the user to find obvious clipping or dead controls.

Record design review date, screens, sizes, observations and user approval in PROGRESS. Screenshot location is a planned evidence path only until a screenshot exists. Unreviewed design remains `proposed`.
