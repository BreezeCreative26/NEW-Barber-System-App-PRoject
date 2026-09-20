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
   - https://dashboard.stripe.com/settings/connect/branding → OLLO logo + colour
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
| `CLICKSEND_FROM` | optional, e.g. `OLLO` (shops override with their own sender name) |
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
- [x] Stripe test webhooks registered (`we_1UHkLj…`, `we_1UHkLk…`) — re-run after key roll
- [x] Resend: send verified from `onboarding@resend.dev` → ollosoftwareio@gmail.com
- [x] ClickSend: credentials verified (balance £1.96)
- [ ] Vercel env vars (step 2) — **needs you** (no Vercel token in the build sandbox)
- [ ] Resend domain (step 3) — **needs your domain**
- [ ] Credential rotation (step 0) — **needs you**
