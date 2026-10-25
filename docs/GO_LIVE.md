# Go live — the owner's click list

Everything the app needs that can only be done from *your* accounts. Code, database and providers
are ready; these are the keys and switches. ~15 minutes.

## 0. Rotate what was pasted into chat (do this first)

| Where | What |
|---|---|
| dashboard.stripe.com → Developers → API keys | **Roll** the secret key (`sk_test_…`). The publishable key is fine. |
| supabase.com → Account → Access tokens | Delete the `sbp_…` token. Project Settings → Database → **Reset database password**, then update `DATABASE_URL` / `DIRECT_URL` in Vercel (step 2). |
| dashboard.clicksend.com → Developers → API credentials | Regenerate the API key. |
| resend.com → API keys | Delete `re_THxm…`, create a new **Sending access** key. |

## 1. Stripe (test mode first)

1. Roll the key (above). Copy the new `sk_test_…`.
2. Re-create the two webhook endpoints with the new key (they're bound to the account, not the key,
   but you need their signing secrets and Stripe only shows them once). From this repo:
   ```
   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs https://new-barber-system-app-p-roject.vercel.app
   ```
   It prints `STRIPE_WEBHOOK_SECRET=whsec_…` and `STRIPE_WEBHOOK_SECRET_CONNECT=whsec_…`.
   (If it says "Updated … Secret unchanged", delete the two `we_…` endpoints in Dashboard →
   Webhooks and run it again.)
3. Dashboard, one time each:
   - https://dashboard.stripe.com/settings/connect/platform-profile → **accept loss liability**
   - https://dashboard.stripe.com/settings/radar → Radar for Platforms **on**
   - https://dashboard.stripe.com/settings/connect/branding → foliyo logo + colour
   - Settings → Payment methods → Apple Pay → add `new-barber-system-app-p-roject.vercel.app`
4. Going live later: complete the business profile, switch to `sk_live_…`, run step 2 again with the
   live key (live-mode endpoints are separate).

## 2. Vercel environment variables

Vercel → project `new-barber-system-app-p-roject` → Settings → Environment Variables → **Production**
(tick Preview too if you want the preview URLs to send real messages — probably not).

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | new `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | from step 1.2 |
| `STRIPE_WEBHOOK_SECRET_CONNECT` | from step 1.2 |
| `CLICKSEND_USERNAME` | `ollosoftwareio@gmail.com` |
| `CLICKSEND_API_KEY` | new key from step 0 |
| `CLICKSEND_FROM` | optional, e.g. `foliyo` (shops override with their own sender name) |
| `RESEND_API_KEY` | new key from step 0 |
| `MAIL_FROM` | **leave unset** until step 3 is done; then `bookings@<your domain>` |
| `CRON_SECRET` | any long random string, e.g. `openssl rand -hex 24` |
| `SENTRY_DSN` | optional — error reports go to stderr without it |

Then Deployments → ⋯ on the latest → **Redeploy** (env changes need a redeploy).
Check: `https://new-barber-system-app-p-roject.vercel.app/api/health` should show
`stripe.provider: "stripe"`, `messaging.email.provider: "resend"`, `messaging.sms.provider: "clicksend"`.

## 3. Email sending domain (Resend)

Until this is done, emails come from `onboarding@resend.dev` and **only deliver to
ollosoftwareio@gmail.com** — customers won't get them.

1. resend.com → Domains → **Add domain** → e.g. `ollo.software` (or a subdomain like `mail.ollo.software`).
2. Resend shows 3 DNS records (MX + 2 TXT: SPF and DKIM). Add them at your DNS provider. Wait for
   "Verified" (minutes to an hour).
3. Vercel → `MAIL_FROM=bookings@ollo.software` → redeploy.
4. Settings → Messages → *Email me a test* from any shop should now arrive at any address.

Tell me the domain and I'll write the exact records into this file.

## 3b. A shop's own web address (optional, per shop)

A shop can book customers on its own domain (`book.theirshop.co.uk`) and send its emails from
`bookings@theirshop.co.uk`, under the shop's name. It is one flow in Settings > Your web address: the shop
types its domain, sees the DNS records to add where it bought the domain, and everything switches over by itself
once those are found. Until then customers keep using the foliyo address, so nothing breaks in between.

**Switching it on (platform):** set these in Vercel, then redeploy.

| Variable | Value |
|---|---|
| `DOMAINS_VERCEL_TOKEN` | A Vercel token that can manage this project's domains |
| `DOMAINS_VERCEL_PROJECT_ID` | The project id (or `VERCEL_PROJECT_ID`) |
| `DOMAINS_VERCEL_TEAM_ID` | The team id, if the project belongs to a team |
| `DOMAINS_RESEND_KEY` | A **full-access** Resend key. The send-only key used for `RESEND_API_KEY` cannot manage domains |

**Per shop:** off until foliyo grants it: Admin > the shop > Features > `custom_domain` > Grant (or later, make it part of a plan or add-on by setting `in_plan`). Without the grant the shop sees a locked screen.

**What happens automatically:** a 5-minute check (the same sweep that sends messages) re-reads both providers. When the web address and the email domain are each verified, that half switches on: the booking site is served on the domain, the foliyo address redirects customer pages there, and customer emails use the new links; when the email domain is verified, mail goes from `bookings@<domain>`. If Resend ever refuses that sender the email is sent from foliyo's address instead of being lost. Live domains are re-checked every few hours, so a removed DNS record falls back to the foliyo address.

**Always on the foliyo address:** staff sign-in, the workspace and all staff links (`<slug>.foliyo.co.uk`). Customers' sign-in cookies belong to the domain they used, so customers who signed in on the old address sign in once on the new one.

**Limits to know:** Vercel and Resend both cap the number of domains per plan; check them before granting many shops. Real DNS and provider verification cannot be tested locally: `tests/support/provider-stub.mjs` stands in for both providers (see the header of `tests/custom-domain.spec.ts`). Before the first real shop, test once with a domain you own.

## 4. ClickSend

- Balance is £1.96 — about 40 texts. Top up at dashboard.clicksend.com → Billing before onboarding
  a real shop (UK SMS ≈ 4–5p each; a busy shop sends ~200/month).
- Alphanumeric sender names (e.g. `FadeSociety`) work in the UK without registration.
- Replies: not handled (senders are one-way). The app's texts say "reply STOP to opt out"; ClickSend
  manages the STOP list automatically for numeric senders only — with alpha senders customers
  can't reply, so keep the manage link in every message (already the case).

## 5. Vercel Cron (already in `vercel.json`)

`/api/cron/messages` every 5 minutes with `Authorization: Bearer $CRON_SECRET`. Vercel wires the
header from the env var automatically. Without it the sweep still runs lazily on traffic; with it
reminders and the 07:00 summaries go out even on a quiet morning.

## 6. First real shop — smoke test (10 minutes, test-mode Stripe)

1. `/signup` → wizard: verify your mobile (real text via ClickSend), add 3 services, invite a barber
   **by text** to your own phone, send yourself a test text and email, pick a slug, go live.
2. Open `/book/<slug>` on your phone → book → you get the confirmation text; the owner email gets
   the *new booking* alert.
3. Settings → Payments → Set up shop payouts → Stripe test onboarding (sort code `108800`, account
   `00012345`, any dummy ID).
4. Turn on deposits → book again → pay with `4242 4242 4242 4242` → manage page says *Deposit paid*.
5. Cancel it from the manage link → refund shows in Stripe; owner gets the *cancellation* alert.

## Status (2026-09-20)

- [x] Code: wizard, invites, forgot/reset, alerts, Stripe v2 accounts, ClickSend, Resend fallback
- [x] Supabase: migration 0014 applied
- [x] Stripe test webhooks registered (`we_1UHm1G…`, `we_1UHm1H…`) — **re-run `stripe-setup.mjs` and update the two Vercel vars after you roll the key**
- [x] Resend: send verified from `onboarding@resend.dev` → ollosoftwareio@gmail.com
- [x] ClickSend: credentials verified (balance £1.96)
- [x] Vercel env vars (step 2) — set 2026-09-20 via API: Stripe key + both webhook secrets (endpoints `we_1UHm1G…`, `we_1UHm1H…`), ClickSend, Resend, CRON_SECRET; empty MAIL_FROM/Twilio removed; redeployed. `/api/health` shows stripe test + clicksend + resend.
- [ ] Resend domain (step 3) — **needs your domain**
- [ ] Credential rotation (step 0) — **needs you** for Stripe / ClickSend / Resend / Vercel token / Supabase access token (all pasted in chat on 2026-09-27)

## Status (2026-09-27)

- [x] **Migrations run on every Vercel build** (`vercel.json` → `buildCommand: npm run db:migrate && npm run build`, against `DIRECT_URL`). A failed migration fails the build, so code never deploys ahead of its schema. 0027 (waiting list v2) ships this way.
- [x] **Supabase migrations 0001–0025 applied** — prod was running the base schema only; `ollo_migrations` did not exist. Now tracked.
- [x] **Database password rotated** via Supabase Management API; `DATABASE_URL` / `DIRECT_URL` updated in Vercel (production + preview); redeployed; `/api/diag?ping=1` → `db_ping: ok`. The new password lives only in Vercel and Supabase — nowhere else.
- [x] `FOLIYO_ADMIN_EMAILS=ollosoftwareio@gmail.com` — sign up (or sign in) with that address and open `/admin`; you are seeded as SUPER. Add others from Admin → Team.
- [x] `CLICKSEND_FROM=foliyo` — texts from shops without their own sender name now show **foliyo**, not a shared number. `/api/health` → `sms.from: "foliyo"`.
- [ ] Rotate the rest yourself (API keys can't roll themselves): Stripe secret key → re-run `stripe-setup.mjs`; ClickSend API key; Resend key (current one is send-only — fine for the app, but it was pasted); Vercel token `vcp_…`; Supabase access token `sbp_…`. Then paste the new values **only into Vercel**, not chat.
- [ ] Deploy PR #1 (`genspark_ai_developer` → `main`) — the code that uses 0025 is not on production yet; the column is there waiting.


## 6b. Legal (before the first real customer)

- [ ] Fill `COMPANY` in `src/server/legal.ts`: registered company name + number, registered office, privacy mailbox (create `privacy@…`), ICO registration number.
- [ ] **Register with the ICO** (data-protection fee, ~£40–60/yr for most small companies) — required for any UK company processing personal data.
- [ ] Have a solicitor review `/legal/terms`, `/legal/privacy`, `/legal/dpa`, `/legal/cookies`. They are drafted to UK GDPR / DPA 2018 / PECR shape but are not legal advice. Bump `LEGAL_VERSIONS` when the wording changes — owners are re-asked on next sign-in.
- [ ] Confirm each sub-processor's DPA is signed/accepted in its dashboard (Stripe, Supabase, Vercel, Resend, Telnyx, ElevenLabs) — Schedule 1 of the DPA relies on them.
- [ ] Decide a breach-response owner and write the runbook (who is told, within what time, by whom). Privacy Policy promises 72 h.

## 7. WhatsApp (Infobip): not used

WhatsApp is **retired**. We are not setting up an Infobip sender or Meta template approval, and
there is nothing to do here. Customers are messaged by text and email. A customer record that still
says WhatsApp as its preference falls back to text. `/api/health` shows `wa.provider: "mailbox"`,
which is expected and sends nothing. The old code and `docs/WHATSAPP.md` are kept for reference only.

## Status (2026-10-25)

- [x] **Live messaging (read from `/api/health`):** email via Resend from `hello@foliyo.co.uk` (Resend DKIM, SPF and DMARC records are published for `foliyo.co.uk`); texts via **Telnyx** from `+447874483391` (this replaces the ClickSend setup described in sections 2 and 4). Check Telnyx balance and UK number approval in Mission Control.
- [x] `CRON_SECRET` set: `/api/cron/messages` refuses unauthenticated calls; Vercel Cron runs it every 5 minutes.
- [x] WhatsApp dropped (section 7).
- [ ] Confirm in the Resend dashboard that `foliyo.co.uk` shows **Verified**; check `/api/health` shows `messaging.email.customer_ready: true` once PR #38 is deployed.
- [ ] Consider tightening DMARC from `p=none` once real mail is arriving.
