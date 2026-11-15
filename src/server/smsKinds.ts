// Which texts a shop sends: one switch per text, so a shop is only billed for the texts it wants.
// Shared by the server (enforcement) and the settings screens (the picker).
export const SMS_KINDS = [
  "confirm",
  "reminder_day",
  "reminder_soon",
  "moved",
  "cancelled",
  "wl_joined",
  "wl_offer",
  "wl_booked",
  "wl_released",
  "review_ask",
  "review_google",
] as const;
export type SmsKind = (typeof SMS_KINDS)[number];

// Older saves used five groups. Each group switches on every text it used to cover, so nothing
// changes for a shop until the owner unticks something.
const LEGACY: Record<string, SmsKind[]> = {
  reminder: ["reminder_day", "reminder_soon"],
  change: ["moved", "cancelled"],
  waitlist: ["wl_joined", "wl_offer", "wl_booked", "wl_released"],
  review: ["review_ask", "review_google"],
};
export const LEGACY_SMS_KINDS = Object.keys(LEGACY);

// Message template -> the switch that controls its text. Templates not listed (sign-in codes,
// contact checks, pay links, account emails, tests, marketing) always send when texts are on.
export const SMS_KIND_OF: Partial<Record<string, SmsKind>> = {
  booking_confirmed: "confirm",
  booking_reminder: "reminder_day",
  booking_reminder_soon: "reminder_soon",
  booking_moved: "moved",
  booking_cancelled: "cancelled",
  waitlist_joined: "wl_joined",
  waitlist_offer: "wl_offer",
  waitlist_open: "wl_offer",
  waitlist_booked: "wl_booked",
  waitlist_released: "wl_released",
  review_request: "review_ask",
  google_review: "review_google",
};

/** Turns a saved list (new ids and/or old group names) into the current ids, in display order. */
export function normaliseSmsKinds(saved: string | null | undefined): SmsKind[] {
  const on = new Set<string>();
  for (const raw of (saved ?? SMS_KINDS.join(",")).split(",")) {
    const k = raw.trim();
    if (LEGACY[k]) LEGACY[k].forEach((x) => on.add(x));
    else on.add(k);
  }
  return SMS_KINDS.filter((k) => on.has(k));
}

export const SMS_KIND_GROUPS: { title: string; kinds: { id: SmsKind; label: string; hint: string }[] }[] = [
  { title: "Bookings", kinds: [
    { id: "confirm", label: "Booking confirmed", hint: "Straight after a customer books." },
    { id: "moved", label: "Booking moved", hint: "When a booking is moved to a new time." },
    { id: "cancelled", label: "Booking cancelled", hint: "When a booking is cancelled." },
  ] },
  { title: "Reminders", kinds: [
    { id: "reminder_day", label: "Day-before reminder", hint: "The day before the appointment." },
    { id: "reminder_soon", label: "Same-day reminder", hint: "A few hours before, with your address." },
  ] },
  { title: "Waiting list", kinds: [
    { id: "wl_joined", label: "Added to the list", hint: "Confirms they're on the waiting list." },
    { id: "wl_offer", label: "Slot opened", hint: "When a time opens up for them." },
    { id: "wl_booked", label: "Booked from the list", hint: "When they take the slot." },
    { id: "wl_released", label: "Back on the list", hint: "When an offer runs out." },
  ] },
  { title: "Reviews", kinds: [
    { id: "review_ask", label: "Review request", hint: "After a visit, asking for a rating." },
    { id: "review_google", label: "Google review nudge", hint: "After a good rating, asking for a Google review." },
  ] },
];
