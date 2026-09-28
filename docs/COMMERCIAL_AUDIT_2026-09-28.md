# foliyo — commercial-grade audit & programme (2026-09-28)

Method: walked owner, barber and customer surfaces on the running build at 1440×900 and 390×844;
read every auth, settings, messaging and page-builder route; screenshots in `docs/evidence/audit-2026-09-28/`.
Legend: **P0** must ship for a paying shop · **P1** week-one friction · **P2** polish.

## 1. Sign-in & accounts

| Finding | Grade | Fix |
| --- | --- | --- |
| Staff sign in only at `/signin` on the root host with the foliyo brand. A barber given `northline.foliyo.co.uk` has no way in from the shop. | P0 | **Staff sign-in on the shop host**: `<slug>.foliyo.co.uk/staff` → shop-branded sign-in (email + password, forgot, invite accept). Customer sign-in page gets a quiet "Work here? Staff sign in" link. Session lands in `/workspace` on the same host. |
| Customer "Text me a code" path (`/start`, `/verify`) creates an account with **no name, email or password** — half-accounts that can't receive email, can't reset. | P0 | After code verify, if the account has no email/password: **finish profile** step (name, email, password, consents, terms) before entering. Server: `/verify` returns `needs_profile`; new `POST /account/complete`. |
| Code sign-in is offered even when the shop has texts **off**. | P0 | Gate on `shop.channels.sms` (server refuses `/start` with 409 `sms_off`; client hides the button). Email remains the standard. |
| Email CTAs link to `/manage/<token>` even for account holders. | P1 | Account holders → `/me` (or `/me?visit=<id>`). Manage token only for guests (voice bookings, imports). |
| Links: `/book/<slug>` on root redirects to sub-domain (good); `/<slug>/me` ditto; workspace links in emails point at root. | P1 | All shop links emitted via `shopUrl()`; workspace/staff links on the shop host. |

## 2. Admin panel (owner + manager)

| Finding | Grade | Fix |
| --- | --- | --- |
| Settings is a flat 12-item list; "Business details" lacks phone, email, socials, VAT, legal name, kind; no "Team & access", "Account/security", "Data & privacy" tabs. | P1 | **New Settings IA** with 6 groups × tabbed sub-panels: Business (Details · Hours · Closures · Location & contact), Bookings (Online booking · Policies & terms · Deposits · Waiting list), Website (Design · Sections · Content · Domain), Customers (Messages · Reminders · Reviews · Marketing), Team (Members & roles · Shifts defaults · Pay), Account (Plan & billing · Security · Data & privacy · Danger zone). Every field from the schema surfaced; per-tab save, dirty-state guard, keyboard nav, phone-first layout. |
| Confirm-email banner + setup banner stack above every page. | P2 | Single dismissible "Getting started" checklist card on Appointments only; email banner collapses to a dot on the account chip. |
| Barber phone view is the owner layout squeezed. | P1 | **Barber app**: Today (agenda list), Week (own column), Customers (own), My pay, Account — bottom tab bar, one-hand reach, tap-to-check-in. |

## 3. Website builder

| Finding | Grade | Fix |
| --- | --- | --- |
| Theme = 6 accents × 6 fonts × light/dark × 2 corners × 3 heroes. No primary/secondary colour, no per-section layout choice. | P0 (your ask) | **Design tokens per shop**: primary, secondary (accent-2), surface tone, ink, font pair (display/text). **Section variants** — each section has a `variant` (e.g. reviews: `cards` `wall` `carousel` `quote`; team: `cards` `list` `portraits` `compact`; services: `menu` `cards` `grid` `tabs`; hero: `editorial` `centred` `split` `cover` `minimal`; hours: `table` `chips`; gallery: `grid` `masonry` `strip`; find: `map` `card`), 32+ combinations total. Auto-optimised at each breakpoint (desktop 3-up → tablet 2-up → phone stack/carousel), all tested with Playwright screenshots. |
| Live preview only shows Phone/Desktop hero. | P1 | Preview renders the real page component with the draft theme; device toggle phone/tablet/desktop. |

## 4. Onboarding

| Finding | Grade | Fix |
| --- | --- | --- |
| 7-step wizard exists but opens as a card inside the workspace; two barbers auto-seeded; no "your link is live" moment; no logo/colour step. | P1 | **Full-screen onboarding**: Brand (logo, primary colour — tone measured) → Hours → Services → Team (invite by email/SMS, only if SMS on) → Messages (email standard; SMS toggle; explains code sign-in unlock) → Booking rules (notice, window, terms) → Payments → **Go live** (address check, preview, share sheet). Progress persisted; resumable. |

## 5. Messaging

| Finding | Grade | Fix |
| --- | --- | --- |
| Emails link to manage tokens; account holders should land in their account. | P1 | See §1. |
| SMS sign-in code offered regardless of shop SMS setting. | P0 | See §1. |

## Programme (each PR merged on green, verified on prod)

1. **PR A — Auth & links**: staff sign-in on shop host; code sign-in gated on SMS + profile completion; account-first email links. *(this session)*
2. **PR B — Settings IA**: new tabbed settings, every field surfaced, phone layout.
3. **PR C — Website builder**: tokens + section variants + responsive preview + screenshot matrix.
4. **PR D — Onboarding**: full-screen flow, go-live moment.
5. **PR E — Barber app**: phone-first agenda + week; owner calendar polish.

## Status (end of session 2026-09-28)

| PR | Scope | State |
| --- | --- | --- |
| A (#12) | Staff sign-in on shop host (`/staff`); code sign-in gated on shop SMS + profile completion (`/account/complete`); messages link account holders to `/me?visit=<id>` | **Merged, live** |
| B part 1 (#13) | Six-group Settings IA; full Business details (type, contact + verification, website, legal name, company no., VAT — migration 0032); Team/Account/Activity inside Settings | **Merged, live** |
| B part 2 | Per-tab dirty-state guard; phone-first settings layout; collapse the two top banners into one "Getting started" card; move Accounts/Audit out of the main nav once tests are updated | Not started |
| C | Website builder: primary/secondary colour tokens, per-section `variant` (hero 5 · services 4 · team 4 · reviews 4 · hours 2 · gallery 3 · find 2 · CTA 2 = 26 + 6 accents ≫ 32 combinations), responsive auto-layout, real-component live preview with phone/tablet/desktop toggle, Playwright screenshot matrix | Not started — schema: `shop_pages.variants_json`, `primary_hex`, `secondary_hex`; render via `data-variant` on each `sp-section` in `ShopPage.tsx`; CSS in `shop-theme.css` |
| D | Full-screen onboarding: Brand → Hours → Services → Team → Messages (SMS toggle unlocks code sign-in) → Booking rules & terms → Payments → Go live (share sheet). Resumable via `setup_json` | Not started — `Setup.tsx` has the 7 steps as a card; promote to a route-level screen |
| E | Barber phone app: Today agenda, Week (own column), Customers (own), My pay, Account — bottom tab bar; owner calendar polish | Not started — `phoneNav` in `Workspace.tsx` is the hook point |
