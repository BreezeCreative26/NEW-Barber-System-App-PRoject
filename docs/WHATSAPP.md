# WhatsApp (Infobip, one OLLO sender)

Customers pick **Text / WhatsApp / Email** on the booking form ("How should we message you?").
The choice is saved on the booking and on their customer record (`contact_pref = WA`), so later
confirmations, moves, cancellations, reminders and codes go to WhatsApp too. Shops can switch
WhatsApp off (Messages → WhatsApp, or the setup wizard); a WA preference then falls back to text.

## How it works
- `src/server/whatsapp.ts` — Infobip provider. Business-initiated messages must use approved
  templates (`WA_TEMPLATES`, `{{1}}` = shop name, URL buttons carry the manage/pay/invite link).
  Inside 24 h of a customer reply, plain text is sent instead.
- `notifications.channel = 'WA'`; the template payload rides in `html` as JSON, `body` is the
  same shop-branded text the SMS would carry (shown in the outbox).
- Permanent WA failure (not on WhatsApp, opted out, template not approved) → an SMS fallback row
  is created and sent immediately (`status_note = Fallback: WhatsApp failed`).
- Webhooks: `POST /api/whatsapp/status` (delivery reports) and `POST /api/whatsapp/inbound`
  (replies; STOP/START toggle `wa_optouts`; replies stored in `wa_inbound`, visible at
  `GET /api/app/notifications/inbound`). Configure both URLs in Infobip → Channels → WhatsApp →
  sender → Webhooks. Set `INFOBIP_WEBHOOK_KEY` and append `?key=…` to the URLs.
- Preview mode (no `INFOBIP_*`): WA rows go to the dev mailbox like SMS/email so the flow can be
  tested. With live SMS but no WhatsApp sender, WA is not offered and prefs fall back to text.

## Test sender (now)
`INFOBIP_WA_SENDER=447860088970`. A phone must first WhatsApp **OLLOSOFTWAREIO** to
+44 7860 088970; only Infobip's stock templates work (confirmations/reminders map onto
`appointment_reminder`, codes onto `authentication`; anything else falls back to text).

## Going live (user side)
1. Infobip portal → Channels → WhatsApp → **Register sender** (Meta embedded signup; needs a
   Meta Business, a phone number not on WhatsApp, display name "OLLO"). Or buy a UK virtual
   number there (~€2.61/mo) and register that.
2. Set `INFOBIP_WA_SENDER` to the new number (digits only) on Vercel; redeploy.
3. `INFOBIP_API_KEY=… INFOBIP_WA_SENDER=… node scripts/whatsapp-templates.mjs --submit` and wait
   for Meta approval (minutes–hours). `node scripts/whatsapp-templates.mjs` lists status.
4. Point the two webhooks at production.
