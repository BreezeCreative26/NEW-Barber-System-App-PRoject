# Waiting list and customer notifications — how it works

The waiting list is the shop's queue for days that are full. This document is the procedure end to
end: how a customer joins, how the shop works the queue from the top bar, how a freed slot is offered,
how the customer accepts, and how every message is recorded before any provider is connected.

## 1. Where it lives

- **Top bar → Queue chip** (`data-testid="queue-chip"`): count of open requests, with a red dot when
  an offer is waiting on a reply. Opens the **Queue drawer** — the one place the list is managed.
  The bell is now only for schedule issues.
- **Settings → Waitlist & messages**: auto-offer on/off, offer hold time, message templates,
  and the **Outbox** (every message the system wanted to send, with its status).
- **Customer side**: join from the booking flow on a full day; see and leave the queue from
  `/<slug>/me`; accept or decline an offer from `/offer/<token>` (no sign-in needed).

## 2. Lifecycle of a request

```
OPEN ──(offer)──► OFFERED ──(accept)──► BOOKED
  │                  │  └──(decline / expires)──► OPEN (back in the queue, offer marked)
  │                  └──(shop books them in by hand)──► BOOKED
  ├──(customer leaves / shop closes)──► CLOSED
  └──(date passes)──► EXPIRED (nightly-on-request sweep, see §6)
```

- **OPEN** — customer asked for a date (+ daypart, optional barber). Nothing is held.
- **OFFERED** — a specific slot (barber, date, start) is offered to this customer until
  `offer_expires_at` (shop setting, default 2 hours). The hold is *soft*: the shop will not offer
  that slot to anyone else while the offer is open, but nothing is written into the diary until the
  customer accepts — accepting runs the normal booking path under every guard, so if a walk-in or
  online customer took the time first the offer page says so and the entry goes back to OPEN.
  (A hard hold that blocks online booking is a later step once we see how often this happens.)
- **BOOKED** — linked to a booking (`booking_id`).
- **CLOSED** — shop closed it (customer found elsewhere, duplicate) or the customer left.
- **EXPIRED** — the requested date has passed with no booking.

## 3. Matching: "who could take this slot?"

`GET /api/sandbox/waitlist/:id/matches` returns the open times on the requested date that fit
the entry: right service, preferred barber (or any eligible barber), inside the preferred daypart
(morning < 12:00, afternoon 12:00–17:00, evening ≥ 17:00), not inside the lead time. Used by the
Queue drawer's **Offer a time** action and by auto-offer.

## 4. Offers

**Manual:** in the Queue drawer, *Offer a time* → pick from matches → `POST /waitlist/:id/offer
{staff_id, date, start_min}`. The server records the offer (`waitlist_offers`), moves the entry to
OFFERED, writes an outbox message with the accept link, and audits `WAITLIST_OFFERED`.

**Automatic (setting, default on):** when a CONFIRMED booking is cancelled or moved — by the
shop, by a manage link, or by a signed-in customer — the server looks for the oldest OPEN entry
whose request fits the freed slot and offers it (one offer per freed slot; the next in line is
offered when the first declines or expires). Audited `WAITLIST_AUTO_OFFERED`.

**Customer reply:** the outbox message carries `/offer/<token>`. That page shows the slot and
two buttons. Accept → a CONFIRMED booking is created (normal manage link issued, customer record
linked, entry BOOKED). Decline → entry back to OPEN, offer marked DECLINED, next in line gets the
slot if auto-offer is on (a customer who declined or let a slot lapse is never auto-offered that
same slot again; staff can still offer it manually). Expiry is enforced lazily: any read of an OFFERED entry past its deadline
releases it first.

**Shop reply on the customer's behalf:** *Book them in* still opens the booking form prefilled;
saving it links the entry (BOOKED). *Close* removes them from the queue.

## 5. Notifications outbox (no provider yet)

`notifications` table: one row per message the system intends to send —
`channel` (SMS | EMAIL), `to`, `template`, `body` (rendered), `status`
(QUEUED | SENT | FAILED | SKIPPED), `related_type/related_id`, timestamps.

Templates (owner-editable wording in Settings, placeholders in braces):

| Template | When | Default body |
|---|---|---|
| `waitlist_joined` | customer joins | "Hi {first}, you're on the list at {shop} for {date} ({daypart}). We'll message you if a time opens up. Reply STOP to leave." |
| `waitlist_offer` | offer created | "Hi {first}, a {service} with {barber} has opened at {shop} on {date} at {time}. It's held for you until {expires}: {link}" |
| `waitlist_booked` | accepted | "You're booked: {service} with {barber} at {shop}, {date} {time}. Ref {ref}. Manage: {manage}" |
| `waitlist_released` | declined/expired | "No problem, {first} — we've put you back on the list for {date}." |

In this build nothing is sent: rows are written as **SKIPPED · no provider**, visible in the
Outbox with a **Copy message** button so staff can text it by hand, and the offer link is shown
in the Queue drawer. When an SMS/email key is added (Later §6 of the customer plan), a sender
flips QUEUED → SENT/FAILED; templates and the outbox do not change.

## 6. Housekeeping

- Expired offers are released on read (any queue fetch, offer page open, or matches call).
- Entries whose date has passed are marked EXPIRED on the next queue fetch.
- Throttles: join ≤10 per phone per 10 min per shop; offer page ≤60 per client per 10 min.

## 7. Settings (shop)

| Setting | Default | Notes |
|---|---|---|
| `waitlist_auto_offer` | on | offer freed slots automatically |
| `waitlist_offer_hold_min` | 120 | how long an offer is held |
| `waitlist_templates_json` | defaults above | per-template wording |

## 8. What the barber sees

Barber accounts see queue entries for themselves or "any barber", can offer their own freed
times and book people in; they cannot change templates or auto-offer.
