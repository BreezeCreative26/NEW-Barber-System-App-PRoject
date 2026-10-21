// Marketing front door at "/". Server-rendered, zero JavaScript, indexable. Signed-in owners never
// see it (they land in the workspace). Layout and copy follow the foliyo brand mockup: dark green /
// cream bands, "Built by barbers. For the industry.", six features, four steps, fixed-fee comparison,
// testimonials, FAQ. Device mocks are pure CSS; photos are our own generated assets.
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);

// Inline icons (stroke = currentColor) so the page stays script-free and one request.
const svg = (d: string, extra = "") => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const ICO = {
  brush: svg('<path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>'),
  dumbbell: svg('<path d="M6.5 6.5v11M17.5 6.5v11M3 9.5v5M21 9.5v5M6.5 12h11"/>'),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  scissors: svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>'),
  sparkle: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>'),
  pen: svg('<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>'),
  heart: svg('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  slash: svg('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  pound: svg('<path d="M17 19H7c2-2 2.5-3.5 2.5-6V9a4 4 0 0 1 7-2.6M6.5 13h7"/>'),
  people: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.5a5 5 0 0 1 6 5.5"/>'),
  team: svg('<circle cx="12" cy="6" r="3"/><circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/><path d="M12 9v3M12 12L7 14.5M12 12l5 2.5"/>'),
  bolt: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
  chart: svg('<path d="M4 19h16M6 16l4-5 3 3 5-7"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
  card: svg('<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M2.5 10h19M6.5 15h4"/>'),
  pin: svg('<path d="M12 21s7-6.5 7-11.5A7 7 0 0 0 5 9.5C5 14.5 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  ig: svg('<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/>'),
  tt: svg('<path d="M15 3v9.5a3.5 3.5 0 1 1-3.5-3.5M15 3a5 5 0 0 0 5 5"/>'),
  yt: svg('<rect x="2.5" y="6" width="19" height="12" rx="4"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>'),
  li: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10v7M8 7v.1M12 17v-4a2.5 2.5 0 0 1 5 0v4M12 10v7"/>'),
};
type Quote = { img: string; name: string; role: string; where: string; quote: string };
type Step = string;
type Faq = { q: string; a: string };
// One layout, several audiences. `/` speaks to every appointment business; `/barbers` is the
// original "Built by barbers" story. Add a vertical by adding an entry — copy only, no new CSS.
export type VerticalSlug = "" | "barbers" | "hair-salons" | "beauty-and-nails" | "tattoo-studios" | "clinics" | "personal-trainers";
export type Vertical = {
  slug: VerticalSlug;
  path: string;
  title: string;
  description: string;
  audience: string;
  heroEyebrow: string;
  heroH1: string;
  heroLede: string;
  heroImg: { src: string; small: string; alt: string };
  everythingLede: string;
  whyH2: string;
  whyLede: string;
  script: string;
  actionH2: string;
  steps: Step[];
  seatWord: string; // "barber or stylist" / "team member"
  seatWordPlural: string;
  chairWord: string; // "chair" / "seat"
  priceListLogin: string;
  cardCopy: string;
  testiEyebrow: string;
  quotes: Quote[];
  faqH2: string;
  faqs: Faq[];
  finalH2: string;
  footerTag: string;
  industries?: { name: string; blurb: string; href?: string; icon: string }[];
  /** Short name for cross-links: "barbers", "hair salons"… */
  short?: string;
};

const BARBER_QUOTES: Quote[] = [
  { img: "dan", name: "Dan", role: "Barber Shop Owner", where: "London", quote: "foliyo has completely changed the way we run our shop. It’s simple, reliable and our clients love the text confirmations." },
  { img: "jess", name: "Jess", role: "Hairdresser", where: "Manchester", quote: "We tried a few booking systems and foliyo is by far the best. It’s so easy to use and knowing exactly what we pay each month is a game-changer." },
  { img: "sam", name: "Sam", role: "Salon Owner", where: "Birmingham", quote: "The support team are unreal. They helped us move everything across from our old system and made it stress free." },
  { img: "ria", name: "Ria", role: "Barber", where: "Leeds", quote: "Finally a booking system that actually understands the industry. Made by people who get it." },
];

const BARBER_FAQS: Faq[] = [
  { q: "Do my customers need an app?", a: "No. They book from your link in any browser, get a text or email with a private link, and can move or cancel from there." },
  { q: "Can I bring my existing customers over?", a: "Yes — import a CSV from your old system in Settings → Customers and their history comes with them." },
  { q: "Do barbers get their own login?", a: "Yes. Invite each barber; they see their own day, take payments at the chair, block their own time and watch their wallet." },
  { q: "What about deposits and no‑shows?", a: "Set a deposit, ask for full prepayment, or let people pay at the chair — one choice for the whole shop, and customers see exactly that when they book. No‑shows can be charged; refunds are automatic when you cancel on them." },
  { q: "What does it really cost?", a: "£24.99 a month, which includes your first barber. Each extra chair is £7.99 — so a three-chair shop pays £40.97. Texts are 6p, email is free. Card payments are optional at 2.2% + 20p all in; leave them off and pay nothing. The AI Concierge is an optional £49 a month. Nothing per booking, no commission, and you can see exactly what you’ve used in your settings." },
  { q: "Is my data safe?", a: "Hosted in the EU, encrypted in transit, backed up daily. You can export everything at any time." },
];

const UNIVERSAL_QUOTES: Quote[] = [
  { img: "dan", name: "Dan", role: "Barbershop Owner", where: "London", quote: "foliyo has completely changed the way we run our shop. It’s simple, reliable and our clients love the text confirmations." },
  { img: "jess", name: "Jess", role: "Beauty Studio Owner", where: "Manchester", quote: "We tried a few booking systems and foliyo is by far the best. It’s so easy to use and knowing exactly what we pay each month is a game-changer." },
  { img: "sam", name: "Sam", role: "Tattoo Artist", where: "Birmingham", quote: "Deposits sorted my no-show problem in a week. The support team helped us move everything across and made it stress free." },
  { img: "ria", name: "Ria", role: "Personal Trainer", where: "Leeds", quote: "My clients book their sessions themselves now and I stopped losing evenings to admin. Made by people who get it." },
];
const UNIVERSAL_FAQS: Faq[] = [
  { q: "Is foliyo right for my kind of business?", a: "If people book a time with you or your team, yes — barbers, salons, beauty and nails, tattoo studios, clinics, personal trainers, therapists, dog groomers, tutors and more. Services, durations, deposits and reminders are all yours to set." },
  { q: "Do my customers need an app?", a: "No. They book from your link in any browser, get a text or email with a private link, and can move or cancel from there." },
  { q: "Can I bring my existing customers over?", a: "Yes — import a CSV from your old system in Settings → Customers and their history comes with them." },
  { q: "Does each team member get their own login?", a: "Yes. Invite each person; they see their own day, take payments, block their own time and watch their earnings." },
  { q: "What about deposits and no‑shows?", a: "Set a deposit, ask for full prepayment, or let people pay on the day — one choice for the whole business, and customers see exactly that when they book. No‑shows can be charged; refunds are automatic when you cancel on them." },
  { q: "What does it really cost?", a: "£24.99 a month, which includes your first team member. Each extra seat is £7.99 — so a team of three pays £40.97. Texts are 6p, email is free. Card payments are optional at 2.2% + 20p all in; leave them off and pay nothing. The AI Concierge is an optional £49 a month. Nothing per booking, no commission." },
  { q: "Is my data safe?", a: "Hosted in the EU, encrypted in transit, backed up daily. You can export everything at any time." },
];

type IndustryCopy = Pick<Vertical, "slug" | "title" | "description" | "audience" | "heroEyebrow" | "heroH1" | "heroLede" | "everythingLede" | "actionH2" | "steps" | "seatWord" | "seatWordPlural" | "chairWord" | "faqH2" | "finalH2" | "short"> & { img: string; alt: string; faqs: Faq[] };
// Industry pages share the universal story (why / pricing / testimonials) and swap the parts that
// should sound like the trade: hero, wording for a seat, booking steps and the first FAQs.
const industry = (c: IndustryCopy): Vertical => ({
  ...c,
  path: `/${c.slug}`,
  heroImg: { src: `/static/landing/hero-${c.img}-hd.webp`, small: `/static/landing/hero-${c.img}-600.webp`, alt: c.alt },
  whyH2: "We listened to the people doing the work.<br/>Then we built what they wanted.",
  whyLede: "foliyo started behind a barber’s chair, after 20 years of using every booking system on the market. It turned out every appointment business had the same complaints: commission, per-booking fees, and software that gets in the way. So we built the system we all wanted.",
  script: "Built by the trade.",
  priceListLogin: `A login for every ${c.seatWord}`,
  cardCopy: "Switch on if you want deposits at booking, prepay or pay on the day. One all-in rate per payment, money goes straight to each team member. Leave it off and pay nothing.",
  testiEyebrow: "Trusted across the appointment trades",
  quotes: UNIVERSAL_QUOTES,
  faqs: [...c.faqs, ...UNIVERSAL_FAQS.slice(1)],
  footerTag: "Built by the trade. For every trade.",
});

export const VERTICALS: Record<"universal" | "barbers" | "salons" | "beauty" | "tattoo" | "clinics" | "trainers", Vertical> = {
  universal: {
    slug: "",
    path: "/",
    title: "foliyo — Booking software for appointment businesses. One fair price, no commission.",
    description: "Online booking, a drag-and-drop calendar, deposits, card payments, team pay and reminders by text, email and push — for barbers, salons, beauty, tattoo, clinics, trainers and any business that runs on appointments. Set up in two minutes. Free to start.",
    audience: "Small appointment-based businesses",
    heroEyebrow: "Booking software for any appointment business",
    heroH1: "Built for people<br/>who run on appointments.",
    heroLede: "foliyo is the all-in-one booking system for barbers, salons, beauty studios, tattoo artists, clinics, trainers and anyone whose day is a diary. One clear monthly price, text and email confirmations and everything you need to run the business — without the commission and hidden fees.",
    heroImg: { src: "/static/landing/hero-universal-hd.webp", small: "/static/landing/hero-universal-600.webp", alt: "A studio owner at her reception desk checking bookings on her phone" },
    everythingLede: "From the first click to the final invoice, foliyo keeps your business running smoothly. Manage bookings, clients, staff, payments and more — all in one easy-to-use platform.",
    whyH2: "We listened to the people doing the work.<br/>Then we built what they wanted.",
    whyLede: "foliyo started behind a barber’s chair, after 20 years of using every booking system on the market. It turned out every appointment business had the same complaints: commission, per-booking fees, and software that gets in the way. So we built the system we all wanted.",
    script: "Built by the trade.",
    actionH2: "Book an appointment<br/>in 7 seconds.",
    steps: ["Select who they want to see", "Choose the service", "Pick a time", "Confirm & they’re all set"],
    seatWord: "team member",
    seatWordPlural: "team members",
    chairWord: "seat",
    priceListLogin: "A login for every team member",
    cardCopy: "Switch on if you want deposits at booking, prepay or pay on the day. One all-in rate per payment, money goes straight to each team member. Leave it off and pay nothing.",
    testiEyebrow: "Trusted across the appointment trades",
    quotes: UNIVERSAL_QUOTES,
    faqH2: "Questions people ask",
    faqs: UNIVERSAL_FAQS,
    finalH2: "Join the barbers, salons, studios and clinics already running on foliyo.",
    footerTag: "Built by the trade. For every trade.",
    industries: [
      { name: "Barbers", blurb: "Where foliyo started. Chairs, walk-ins, pay at the chair.", href: "/barbers", icon: "scissors" },
      { name: "Hair & salons", blurb: "Colour, cuts, long services and split appointments.", href: "/hair-salons", icon: "sparkle" },
      { name: "Beauty & nails", blurb: "Deposits, add-ons and packed-out Saturdays.", href: "/beauty-and-nails", icon: "brush" },
      { name: "Tattoo & piercing", blurb: "Consults, sittings and deposits that stick.", href: "/tattoo-studios", icon: "pen" },
      { name: "Clinics & therapists", blurb: "Client notes, intake and reminders that cut no-shows.", href: "/clinics", icon: "heart" },
      { name: "Trainers & coaching", blurb: "Sessions, blocks and clients who book themselves.", href: "/personal-trainers", icon: "dumbbell" },
    ],
  },
  barbers: {
    slug: "barbers",
    path: "/barbers",
    title: "foliyo for Barbers — Built by barbers. For the industry. Barbershop booking software",
    description: "Barbershop booking software: online booking, a drag-and-drop calendar, deposits and pay-at-the-chair, barber pay runs, reminders by text, email and push. Set up your shop in two minutes. Free to start.",
    audience: "Barbershops and independent barbers",
    heroEyebrow: "Booking software for barbers, hairdressers &amp; salons",
    heroH1: "Built by barbers.<br/>For the industry.",
    heroLede: "foliyo is the all-in-one booking system designed specifically for barbers, hairdressers and salons. With one clear monthly price, text confirmations and everything you need to run your shop — we’ve taken the best bits from other platforms and removed all the things you don’t want.",
    heroImg: { src: "/static/landing/hero-barbers-hd.webp", small: "/static/landing/hero-barbers-600.webp", alt: "A barber cutting a client’s hair" },
    everythingLede: "From the first click to the final cut, foliyo keeps your shop running smoothly. Manage bookings, clients, barbers, payments and more — all in one easy-to-use platform.",
    whyH2: "We listened to the industry.<br/>Then we built what we wanted.",
    whyLede: "After 20 years behind the chair, we’ve used almost every booking system on the market. We loved some things, we hated others. So we created foliyo — a complete system built by barbers, for barbers, hairdressers and salon owners.",
    script: "Built by barbers.",
    actionH2: "Book a haircut<br/>in 7 seconds.",
    steps: ["Select your barber or stylist", "Choose your service", "Pick a time", "Confirm & you’re all set"],
    seatWord: "barber or stylist",
    seatWordPlural: "barbers",
    chairWord: "chair",
    priceListLogin: "A login for every barber",
    cardCopy: "Switch on if you want deposits at booking, prepay or pay at the chair. One all-in rate per payment, money goes straight to each barber. Leave it off and pay nothing.",
    testiEyebrow: "Trusted by barbers, hairdressers &amp; salon owners",
    quotes: BARBER_QUOTES,
    faqH2: "Questions barbers ask",
    faqs: BARBER_FAQS,
    finalH2: "Join hundreds of barbers, hairdressers and salons already using foliyo.",
    footerTag: "Built by barbers. For the industry.",
    short: "barbers",
  },
  salons: industry({
    slug: "hair-salons",
    short: "hair salons",
    img: "salons",
    alt: "A stylist blow-drying a client’s hair in a bright salon",
    title: "foliyo for Hair Salons — Salon booking software with no commission",
    description: "Salon booking software: online booking, colour and processing time, split appointments, deposits, stylist pay runs and reminders by text, email and push. One fair monthly price, no commission.",
    audience: "Hair salons and independent stylists",
    heroEyebrow: "Booking software for hair salons &amp; stylists",
    heroH1: "Every colour<br/>and cut, booked.",
    heroLede: "Long colour services, processing time, add-on treatments and stylists with their own regulars — foliyo keeps the whole salon diary in one place, with one clear monthly price and no commission on your clients.",
    everythingLede: "From the first consultation to the final blow-dry, foliyo keeps your salon running smoothly. Bookings, client notes and formulas, stylists, payments and more — all in one place.",
    actionH2: "Book a colour<br/>in 7 seconds.",
    steps: ["Choose a stylist", "Pick the service and add-ons", "Pick a time", "Confirm & you’re all set"],
    seatWord: "stylist",
    seatWordPlural: "stylists",
    chairWord: "chair",
    faqH2: "Questions salons ask",
    finalH2: "Join the salons and stylists already running on foliyo.",
    faqs: [
      { q: "Can I book long colour services with processing time?", a: "Yes. Set a service’s length and any buffer after it, and foliyo blocks exactly the right time in the stylist’s column so nothing overlaps." },
      { q: "Can clients add a treatment or toner when they book?", a: "Yes. Add-ons sit under each service with their own price and time, and the booking adds them up automatically." },
    ],
  }),
  beauty: industry({
    slug: "beauty-and-nails",
    short: "beauty and nails",
    img: "beauty",
    alt: "A nail technician painting a client’s nails at a marble table",
    title: "foliyo for Beauty & Nails — Booking software for beauty studios",
    description: "Booking software for beauty and nail studios: deposits that cut no-shows, add-ons, patch-test reminders, a team calendar and text, email and push reminders. One fair monthly price, no commission.",
    audience: "Beauty salons, nail technicians and lash and brow studios",
    heroEyebrow: "Booking software for beauty, nails, lashes &amp; brows",
    heroH1: "Full books.<br/>Fewer no-shows.",
    heroLede: "Deposits at booking, reminders that actually get read and add-ons clients pick themselves. foliyo fills your Saturdays and protects your time, with one clear monthly price and no commission.",
    everythingLede: "From the first booking to the aftercare text, foliyo keeps your studio running smoothly. Bookings, client notes, deposits, your team and payments — all in one easy-to-use platform.",
    actionH2: "Book a set of nails<br/>in 7 seconds.",
    steps: ["Choose a technician", "Pick the treatment and extras", "Pick a time", "Pay the deposit & you’re booked"],
    seatWord: "technician",
    seatWordPlural: "technicians",
    chairWord: "seat",
    faqH2: "Questions beauty studios ask",
    finalH2: "Join the beauty and nail studios already running on foliyo.",
    faqs: [
      { q: "Can I take a deposit to stop no-shows?", a: "Yes. Ask for a fixed deposit, a percentage or full prepayment, studio-wide or per treatment. Late cancellations and no-shows can keep the deposit; cancel on them and it’s refunded automatically." },
      { q: "Can clients add extras like nail art or a lash tint?", a: "Yes. Add-ons sit under each treatment with their own price and time, and the booking adds them up automatically." },
    ],
  }),
  tattoo: industry({
    slug: "tattoo-studios",
    short: "tattoo studios",
    img: "tattoo",
    alt: "A tattoo artist working on a client’s forearm in a clean studio",
    title: "foliyo for Tattoo Studios — Booking and deposits for tattoo and piercing",
    description: "Booking software for tattoo and piercing studios: consultations, multi-session pieces, deposits that stick, artist calendars and reminders by text, email and push. One fair monthly price, no commission.",
    audience: "Tattoo and piercing studios and independent artists",
    heroEyebrow: "Booking software for tattoo &amp; piercing studios",
    heroH1: "Book the sitting.<br/>Keep the deposit.",
    heroLede: "Take a deposit when the date is booked, keep every sitting of a big piece with the right artist, and let walk-in piercings fill the gaps. One clear monthly price and no commission on your clients.",
    everythingLede: "From the first consult to the final session, foliyo keeps your studio running smoothly. Artists’ diaries, client notes, deposits and payments — all in one place.",
    actionH2: "Book a sitting<br/>in 7 seconds.",
    steps: ["Choose an artist", "Pick a consult or sitting", "Pick a time", "Pay the deposit & you’re booked"],
    seatWord: "artist",
    seatWordPlural: "artists",
    chairWord: "seat",
    faqH2: "Questions tattoo studios ask",
    finalH2: "Join the tattoo and piercing studios already running on foliyo.",
    faqs: [
      { q: "Can I take a deposit when someone books?", a: "Yes. Set a deposit for the shop or ask for full prepayment. It’s taken at booking and shown on the appointment and the final bill." },
      { q: "Can I book long sessions and keep notes on the design?", a: "Yes. Services can be as long as you need, and each client has private notes and history only your team can see." },
    ],
  }),
  clinics: industry({
    slug: "clinics",
    short: "clinics and therapists",
    img: "clinics",
    alt: "A physiotherapist assessing a client’s shoulder in a bright treatment room",
    title: "foliyo for Clinics & Therapists — Appointment booking for practitioners",
    description: "Appointment software for clinics, physios, massage and therapists: online booking, client notes, reminders that cut no-shows, practitioner calendars and card payments. One fair monthly price, no commission.",
    audience: "Clinics, physiotherapists, massage therapists and wellbeing practitioners",
    heroEyebrow: "Booking software for clinics, physios &amp; therapists",
    heroH1: "Calmer days.<br/>Fewer empty slots.",
    heroLede: "Clients book their own appointments, get reminders that cut no-shows and pay when they arrive. foliyo keeps every practitioner’s diary, client notes and payments in one place, with one clear monthly price.",
    everythingLede: "From the first booking to the follow-up, foliyo keeps your practice running smoothly. Diaries, client records and notes, practitioners and payments — all in one easy-to-use platform.",
    actionH2: "Book a session<br/>in 7 seconds.",
    steps: ["Choose a practitioner", "Pick the treatment", "Pick a time", "Confirm & you’re all set"],
    seatWord: "practitioner",
    seatWordPlural: "practitioners",
    chairWord: "room",
    faqH2: "Questions clinics ask",
    finalH2: "Join the clinics and therapists already running on foliyo.",
    faqs: [
      { q: "Can I keep private notes on each client?", a: "Yes. Every client has notes and a full visit history that only your team can see — never shown on the booking page or in messages." },
      { q: "Do reminders really reduce no-shows?", a: "Yes. Clients get a confirmation and a reminder by text, email or push before every visit, with a private link to move or cancel — so a slot is freed instead of wasted." },
    ],
  }),
  trainers: industry({
    slug: "personal-trainers",
    short: "personal trainers",
    img: "trainers",
    alt: "A personal trainer coaching a client through a kettlebell squat",
    title: "foliyo for Personal Trainers — Session booking for trainers and coaches",
    description: "Booking software for personal trainers and coaches: clients book their own sessions, reminders by text, email and push, card payments and a clear diary across the team. One fair monthly price, no commission.",
    audience: "Personal trainers, coaches and small studios",
    heroEyebrow: "Booking software for personal trainers &amp; coaches",
    heroH1: "Clients book.<br/>You coach.",
    heroLede: "Stop losing evenings to messages about times. Clients book and move their own sessions, get reminders and pay up front or on the day — one clear monthly price, no commission.",
    everythingLede: "From the first session to the hundredth, foliyo keeps your training business running smoothly. Your diary, clients, coaches and payments — all in one easy-to-use platform.",
    actionH2: "Book a session<br/>in 7 seconds.",
    steps: ["Choose a coach", "Pick the session", "Pick a time", "Confirm & you’re all set"],
    seatWord: "coach",
    seatWordPlural: "coaches",
    chairWord: "seat",
    faqH2: "Questions trainers ask",
    finalH2: "Join the trainers and coaches already running on foliyo.",
    faqs: [
      { q: "Can clients move their own sessions?", a: "Yes. Every confirmation has a private link to move or cancel within the notice you set, so you’re not stuck rearranging by message." },
      { q: "Can I take payment up front?", a: "Yes. Ask for full prepayment or a deposit per session type, or let clients pay on the day. Card payments are optional at 2.2% + 20p." },
    ],
  }),
};
/** Every industry page (all verticals except the universal front page), keyed by URL path. */
export const INDUSTRY_PAGES: Vertical[] = Object.values(VERTICALS).filter((v) => v.slug !== "");

// The "next up" card floating over each hero photo: a believable service for that trade.
const NEXT_UP: Record<VerticalSlug, string> = { "": "Cut & finish", barbers: "Skin fade", "hair-salons": "Balayage", "beauty-and-nails": "Gel manicure", "tattoo-studios": "Sleeve, session 2", clinics: "Sports massage", "personal-trainers": "PT session" };

export function landingPage(origin: string, v: Vertical = VERTICALS.universal) {
  const { title, description } = v;
  const ld = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "foliyo",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description,
    url: origin,
    offers: { "@type": "Offer", price: "0", priceCurrency: "GBP", description: "Free to set up. Card fees only when you take payments." },
    audience: { "@type": "Audience", audienceType: v.audience },
  };
  return `<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
<link rel="canonical" href="${esc(origin)}${v.path === "/" ? "/" : v.path}"/>
<meta property="og:type" content="website"/><meta property="og:site_name" content="foliyo"/>
<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/>
<meta property="og:url" content="${esc(origin)}${v.path === "/" ? "/" : v.path}"/><meta property="og:image" content="${esc(origin)}${v.heroImg.src}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="theme-color" content="#0b0b0c"/>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/><link rel="icon" href="/favicon.ico" sizes="32x32"/><link rel="apple-touch-icon" href="/foliyo-apple-touch-icon.png"/><link rel="manifest" href="/site.webmanifest"/>
<link rel="stylesheet" href="/static/design.css"/>
<link rel="stylesheet" href="/static/landing.css"/>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body class="landing">
<header class="l-header">
  <div class="l-wrap l-header-in">
    <a class="l-brand" href="/" aria-label="foliyo home"><img src="/static/brand/foliyo-wordmark-white.svg" alt="foliyo" width="91" height="34"/></a>
    <nav class="l-nav" aria-label="Site">
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="#about">About</a>
      ${v.industries ? `<a href="#industries">Industries</a>` : `<a href="/">All industries</a>`}
      <a href="#faq">FAQ</a>
    </nav>
    <div class="l-header-cta">
      <a class="l-signin" href="/signin">Find your shop</a>
      <a class="l-btn l-btn-outline" href="/signup" data-testid="landing-cta-header">Start Free Trial</a>
    </div>
  </div>
</header>

<main id="main">
  <!-- 1. Hero -->
  <section class="l-hero" aria-labelledby="hero-heading">
    <div class="l-wrap l-two">
      <div class="l-hero-copy">
        <p class="l-eyebrow">${v.heroEyebrow}</p>
        <h1 id="hero-heading">${v.heroH1}</h1>
        <p class="l-lede">${v.heroLede}</p>
        <div class="l-ctas">
          <a class="l-btn l-btn-green" href="/signup" data-testid="landing-cta-hero">Start Free Trial</a>
          <a class="l-btn l-btn-outline" href="/signin#demo">Book a Demo</a>
        </div>
        <ul class="l-trust">
          <li><i class="l-ico">${ICO.check}</i>No Commission</li>
          <li><i class="l-ico">${ICO.chat}</i>Text &amp; Email Reminders</li>
          <li><i class="l-ico">${ICO.slash}</i>No Hidden Costs</li>
        </ul>
        ${v.industries ? `<a class="l-hero-vertical" href="#industries">${ICO.scissors} Barber, salon, studio or clinic? <b>Find your trade →</b></a>` : `<a class="l-hero-vertical" href="/">${ICO.check} Different kind of business? <b>foliyo works for every appointment business →</b></a>`}
      </div>
      <div class="l-hero-visual">
        <picture>
          <source media="(max-width: 720px)" srcset="${v.heroImg.small}"/>
          <img class="l-hero-photo" src="${v.heroImg.src}" srcset="${v.heroImg.small} 600w, ${v.heroImg.src} 1086w" sizes="(max-width: 980px) 92vw, 560px" alt="${esc(v.heroImg.alt)}" width="1086" height="1448" fetchpriority="high"/>
        </picture>
        <div class="l-chip l-chip-next" aria-hidden="true"><i class="l-chip-dot"></i><span><small>Next up · 11:30</small><b>Jake · ${esc(NEXT_UP[v.slug])}</b></span></div>
        <div class="l-chip l-chip-paid" aria-hidden="true"><i class="l-ico l-ico-fill l-ico-sm">${ICO.check}</i><span><small>Deposit paid</small><b>£10.00</b></span></div>
        <div class="l-phone l-phone-hero" role="img" aria-label="A text confirmation from the shop: appointment confirmed for Friday 15th May at 11:30am with Sam.">
          <div class="l-phone-top"><img src="/static/brand/foliyo-wordmark-ink.svg" alt="" width="45" height="17"/></div>
          <div class="l-phone-card">
            <b>Appointment Confirmed!</b>
            <p>Hi Jake, your appointment is confirmed for <strong>Friday 15th May at 11:30am</strong> with <strong>Sam</strong>.</p>
            <p>See you soon!<br/>— The team at foliyo</p>
            <span class="l-phone-btn">View Details</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 2. Everything you need -->
  <section id="features" class="l-light l-everything" aria-labelledby="everything-heading">
    <div class="l-wrap l-two">
      <div>
        <p class="l-eyebrow">Everything you need</p>
        <h2 id="everything-heading">Run your entire<br/>appointment business<br/>from one place.</h2>
        <p class="l-lede">${v.everythingLede}</p>
        <a class="l-btn l-btn-green" href="#why" data-testid="landing-cta-features">See all features</a>
      </div>
      <div class="l-devices">
        <div class="l-laptop" role="img" aria-label="The foliyo calendar on a laptop: a week of colour-coded appointments across the team.">
          <div class="l-laptop-screen">
            <div class="l-cal-side"><img src="/static/brand/foliyo-wordmark-ink.svg" alt="" width="48" height="18"/><span class="on">Calendar</span><span>Clients</span><span>Team</span><span>Payments</span><span>Reports</span><span>Settings</span></div>
            <div class="l-cal">
              <div class="l-cal-head"><b>Fri, 15 May 2026</b><span>Jay · Marcus · Dani</span></div>
              <div class="l-cal-grid">
                <div class="l-cal-times"><span>09:00</span><span>10:00</span><span>11:00</span><span>12:00</span><span>13:00</span><span>14:00</span></div>
                <div class="l-cal-col"><i class="c-blue r0 h2">Dave Smith<small>Skin fade</small></i><i class="c-green r3 h2">Sarah Fox<small>Cut &amp; finish</small></i><i class="c-orange r6 h1">Jake Reed<small>Beard</small></i></div>
                <div class="l-cal-col"><i class="c-purple r1 h2">Harry Davis<small>Signature cut</small></i><i class="c-blue r4 h3">Tom Reyes<small>Cut &amp; beard</small></i></div>
                <div class="l-cal-col"><i class="c-orange r0 h1">Leo Grant<small>Line up</small></i><i class="c-green r2 h2">Priya Nair<small>Colour</small></i><i class="c-purple r5 h2">Kofi Mensah<small>Fade</small></i></div>
              </div>
            </div>
          </div>
          <div class="l-laptop-base"></div>
        </div>
        <div class="l-phone l-phone-book" role="img" aria-label="The client booking screen on a phone.">
          <div class="l-phone-top"><img src="/static/brand/foliyo-wordmark-ink.svg" alt="" width="40" height="15"/></div>
          <p class="l-phone-h">Book an appointment</p>
          <ul class="l-phone-list">
            <li><span>Dave Smith</span><small>10:00 · Skin fade</small></li>
            <li><span>Sarah Fox</span><small>11:30 · Cut &amp; finish</small></li>
            <li><span>Jake Reed</span><small>13:00 · Beard trim</small></li>
            <li><span>Harry Davis</span><small>14:15 · Signature cut</small></li>
          </ul>
          <span class="l-phone-btn l-phone-btn-green">Confirm booking</span>
        </div>
      </div>
    </div>
  </section>

  <!-- 3. Why foliyo -->
  <section id="why" class="l-dark l-why" aria-labelledby="why-heading">
    <div class="l-wrap l-two l-two-wide">
      <div>
        <p class="l-eyebrow">Why foliyo?</p>
        <h2 id="why-heading">${v.whyH2}</h2>
        <p class="l-lede">${v.whyLede}</p>
        <p class="l-script" aria-hidden="true">${v.script}</p>
      </div>
      <ul class="l-grid6">
        <li><i class="l-ico">${ICO.pound}</i><b>Fair Monthly Price</b><p>From £24.99 a month. Never a fee per booking, never a cut of your clients.</p></li>
        <li><i class="l-ico">${ICO.people}</i><b>Client Management</b><p>Keep track of appointments, notes, preferences and more.</p></li>
        <li><i class="l-ico">${ICO.chat}</i><b>Text, Email &amp; Push</b><p>Confirmations and reminders by text, email and app notifications — in your shop’s name.</p></li>
        <li><i class="l-ico">${ICO.team}</i><b>Staff &amp; Multi-Location</b><p>Manage your team, multiple ${v.chairWord}s or multiple locations from one dashboard.</p></li>
        <li><i class="l-ico">${ICO.bolt}</i><b>Easy To Use</b><p>Get set up in minutes. No complicated training.</p></li>
        <li><i class="l-ico">${ICO.chart}</i><b>Payments &amp; Reports</b><p>Take payments, track your income and get the insights you need to grow.</p></li>
      </ul>
    </div>
  </section>

  <!-- 4. See it in action -->
  <section id="about" class="l-light l-action" aria-labelledby="action-heading">
    <div class="l-wrap l-two">
      <div class="l-action-visual">
        <div class="l-phone l-phone-wa" role="img" aria-label="A text message from the shop confirming an appointment.">
          <div class="l-phone-top l-phone-top-wa"><img src="/static/brand/foliyo-wordmark-ink.svg" alt="foliyo" width="58" height="22"/><small>online</small></div>
          <div class="l-wa-bubble">
            <p>Hi Jake,<br/>Your appointment is confirmed for <strong>Friday 15th May at 11:30am</strong> with <strong>Sam</strong>.</p>
            <p>See you soon!<br/>— The team at foliyo</p>
            <span class="l-phone-btn l-phone-btn-light">View Details</span>
            <time>11:02</time>
          </div>
        </div>
      </div>
      <div>
        <p class="l-eyebrow">See it in action</p>
        <h2 id="action-heading">${v.actionH2}</h2>
        <p class="l-lede">Fast. Simple. No faff. Whether it’s a new booking, rebooking or a last-minute slot — foliyo makes it easy for your clients and your team.</p>
        <ol class="l-steps">
          ${v.steps.map((t, i) => `<li><span>${i + 1}</span>${esc(t)}</li>`).join("")}
        </ol>
        <aside class="l-callout">
          <i class="l-ico l-ico-fill">${ICO.bolt}</i>
          <div><b>Set up a new staff member in 30 seconds.</b><a href="/signin#demo">Watch the demo →</a></div>
          <span class="l-dots" aria-hidden="true"><i class="on"></i><i></i><i></i><i></i></span>
        </aside>
      </div>
    </div>
  </section>

  <!-- 5. Fair pricing -->
  <section class="l-dark l-fee" aria-labelledby="fee-heading">
    <div class="l-wrap l-two">
      <div>
        <figure class="l-photo-card">
          <img src="/static/landing/shop-interior.webp" alt="" width="800" height="600" loading="lazy"/>
          <figcaption>More<br/>appointments.<br/>Less admin.</figcaption>
        </figure>
        <p class="l-eyebrow">Fair pricing</p>
        <h2 id="fee-heading">Your business grows.<br/>We don’t take a cut.</h2>
        <p class="l-lede">Unlike other booking systems, we never charge per booking and never take commission on your clients. One clear monthly price for the system, and you only pay for the extras you actually use — at prices you can see up front.</p>
        <a class="l-btn l-btn-outline" href="#pricing" data-testid="landing-cta-pricing">View Pricing</a>
      </div>
      <div class="l-compare">
        <div class="l-compare-card">
          <p class="l-compare-h">Other platforms</p>
          <ul>
            <li><i class="l-x">${ICO.x}</i>Charge per booking</li>
            <li><i class="l-x">${ICO.x}</i>Take 20% of new clients</li>
            <li><i class="l-x">${ICO.x}</i>Lock features behind higher tiers</li>
            <li><i class="l-x">${ICO.x}</i>Hide the real cost of texts</li>
          </ul>
        </div>
        <div class="l-compare-card l-compare-ollo">
          <p class="l-compare-h"><img src="/static/brand/foliyo-wordmark-white.svg" alt="foliyo" width="59" height="22"/></p>
          <ul>
            <li><i class="l-tick">${ICO.check}</i>No commission, ever</li>
            <li><i class="l-tick">${ICO.check}</i>Every feature on every plan</li>
            <li><i class="l-tick">${ICO.check}</i>Extras priced in plain sight</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- 6. Pricing -->
  <section id="pricing" class="l-light l-pricing" aria-labelledby="pricing-heading">
    <div class="l-wrap">
      <div class="l-center">
        <p class="l-eyebrow">Pricing</p>
        <h2 id="pricing-heading">Simple, honest pricing.</h2>
        <p class="l-lede l-lede-center">One monthly price for the system, first ${v.seatWord} included. Add extras only if you want them. Cancel any time.</p>
      </div>
      <div class="l-price-grid">
        <article class="l-price-main">
          <header class="l-price-head">
            <p class="l-price-label">The system</p>
            <p class="l-price-big">£24.99<small>/month</small></p>
            <p class="l-price-sub">Includes your first ${v.seatWord}. Each extra ${v.chairWord} is <strong>£7.99</strong> a month.</p>
          </header>
          <ul class="l-price-chairs" aria-label="Monthly price by team size">
            <li><span>Solo</span><b>£24.99</b></li>
            <li><span>2 ${v.chairWord}s</span><b>£32.98</b></li>
            <li><span>3 ${v.chairWord}s</span><b>£40.97</b></li>
            <li><span>5 ${v.chairWord}s</span><b>£56.95</b></li>
          </ul>
          <ul class="l-price-list">
            <li><i class="l-tick">${ICO.check}</i>Online booking page with your name and logo</li>
            <li><i class="l-tick">${ICO.check}</i>Drag-and-drop calendar for the whole team</li>
            <li><i class="l-tick">${ICO.check}</i>Unlimited bookings — never a per-booking fee</li>
            <li><i class="l-tick">${ICO.check}</i>Client records, notes and history</li>
            <li><i class="l-tick">${ICO.check}</i>Email confirmations and reminders included</li>
            <li><i class="l-tick">${ICO.check}</i>No-show protection and pay runs</li>
            <li><i class="l-tick">${ICO.check}</i>${v.priceListLogin}</li>
            <li><i class="l-tick">${ICO.check}</i>Reports and daily summaries</li>
          </ul>
          <footer class="l-price-foot">
            <a class="l-btn l-btn-green" href="/signup" data-testid="landing-cta-pricing-main">Start Free Trial</a>
            <p class="l-tiny">14 days free · no card needed · no contract</p>
          </footer>
        </article>
        <div class="l-price-extras">
          <p class="l-price-label">Optional extras — pay only for what you use</p>
          <article class="l-extra">
            <i class="l-ico">${ICO.chat}</i>
            <div class="l-extra-body">
              <div class="l-extra-top"><b>Messages</b><span class="l-extra-price">6p <small>a text</small></span></div>
              <p>Text confirmations and reminders 6p each. Email and app notifications always free. Your clients choose how they hear from you.</p>
            </div>
          </article>
          <article class="l-extra l-extra-hi">
            <i class="l-ico l-ico-fill">${ICO.phone}</i>
            <div class="l-extra-body">
              <div class="l-extra-top"><b>AI Concierge <span class="l-pill">New</span></b><span class="l-extra-price">£49 <small>a month</small></span></div>
              <p>Answers your phone 24/7 in your shop’s name, checks the diary, books, moves and cancels appointments and takes messages. 300 call minutes included, then 12p a minute.</p>
            </div>
          </article>
          <article class="l-extra">
            <i class="l-ico">${ICO.card}</i>
            <div class="l-extra-body">
              <div class="l-extra-top"><b>Card payments <span class="l-pill l-pill-soft">Optional</span></b><span class="l-extra-price">2.2% <small>+ 20p</small></span></div>
              <p>${v.cardCopy}</p>
            </div>
          </article>
          <p class="l-tiny">Prices are what you pay — no VAT is added. Extras are billed monthly on what you actually used — shown live in your settings, no surprises.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- 6b. Industries (universal page) -->
  ${v.industries ? `<section id="industries" class="l-dark l-industries" aria-labelledby="industries-heading">
    <div class="l-wrap">
      <div class="l-center l-center-dark">
        <p class="l-eyebrow">Who it’s for</p>
        <h2 id="industries-heading">One system. Every appointment business.</h2>
        <p class="l-lede l-lede-center">Same calendar, same fair price. Pick your trade to see how shops like yours use foliyo.</p>
      </div>
      <ul class="l-industries-grid">
        ${v.industries.map((i) => { const page = INDUSTRY_PAGES.find((x) => x.path === i.href); return `<li class="${i.href ? "l-ind-link" : ""}">${i.href ? `<a href="${i.href}">` : "<div>"}${page ? `<img class="l-ind-img" src="${page.heroImg.small}" alt="" width="600" height="800" loading="lazy"/>` : ""}<span class="l-ind-body"><i class="l-ico">${ICO[i.icon as keyof typeof ICO] || ICO.check}</i><b>${esc(i.name)}</b><p>${esc(i.blurb)}</p>${i.href ? `<span class="l-ind-more">See foliyo for ${esc(page?.short || i.name.toLowerCase())} →</span>` : ""}</span>${i.href ? "</a>" : "</div>"}</li>`; }).join("")}
      </ul>
    </div>
  </section>` : ""}

  <!-- 7. Testimonials -->
  <section id="testimonials" class="l-light l-testi" aria-labelledby="testi-heading">
    <div class="l-wrap">
      <div class="l-center">
        <p class="l-eyebrow">${v.testiEyebrow}</p>
        <h2 id="testi-heading">Real businesses. Real results.</h2>
      </div>
      <ul class="l-quotes">
        ${v.quotes.map((q) => `<li>
          <div class="l-quote-who"><img src="/static/landing/face-${q.img}.webp" alt="" width="44" height="44" loading="lazy"/><div><b>${q.name}</b><small>${q.role}</small></div></div>
          <p class="l-stars" aria-label="5 out of 5 stars">★★★★★</p>
          <p class="l-quote">“${q.quote}”</p>
          <p class="l-where"><i class="l-ico l-ico-sm">${ICO.pin}</i>${q.where}</p>
        </li>`).join("")}
      </ul>
    </div>
  </section>

  <!-- 8. FAQ -->
  <section id="faq" class="l-light l-faq" aria-labelledby="faq-heading">
    <div class="l-wrap l-faq-in">
      <div><p class="l-eyebrow">FAQ</p><h2 id="faq-heading">${v.faqH2}</h2></div>
      <div>
        ${v.faqs.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("\n        ")}
      </div>
    </div>
  </section>

  <!-- 9. Final CTA -->
  <section class="l-dark l-final" aria-labelledby="final-heading">
    <div class="l-wrap l-two l-final-in">
      <div>
        <p class="l-eyebrow">Ready to get started?</p>
        <h2 id="final-heading">${v.finalH2}</h2>
      </div>
      <div class="l-final-right">
        <div class="l-ctas">
          <a class="l-btn l-btn-green" href="/signup" data-testid="landing-cta-final">Start Free Trial</a>
          <a class="l-btn l-btn-outline" href="/signin#demo">Book a Demo</a>
        </div>
        <ul class="l-trust">
          <li><i class="l-ico">${ICO.check}</i>No setup fees</li>
          <li><i class="l-ico">${ICO.check}</i>Cancel anytime</li>
          <li><i class="l-ico">${ICO.check}</i>UK based support</li>
        </ul>
      </div>
    </div>
  </section>
</main>

<footer class="l-footer l-dark">
  <div class="l-wrap l-footer-in">
    <div>
      <a class="l-brand" href="/" aria-label="foliyo home"><img src="/static/brand/foliyo-wordmark-white.svg" alt="foliyo" width="75" height="28"/></a>
      <p class="l-tiny">© ${new Date().getFullYear()} foliyo. All rights reserved.</p>
    </div>
    <nav aria-label="Footer"><a href="/">foliyo for every business</a>${INDUSTRY_PAGES.map((p) => `<a href="${p.path}">For ${esc(p.short || p.slug)}</a>`).join("")}<a href="#features">Features</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/dpa">DPA</a><a href="/legal/cookies">Cookies</a><a href="/signin">Sign in</a><a href="/signup">Create your shop</a></nav>
    <div class="l-footer-right">
      <div class="l-social" aria-label="Social">
        <a href="https://instagram.com" aria-label="Instagram" rel="noopener">${ICO.ig}</a>
        <a href="https://tiktok.com" aria-label="TikTok" rel="noopener">${ICO.tt}</a>
        <a href="https://youtube.com" aria-label="YouTube" rel="noopener">${ICO.yt}</a>
        <a href="https://linkedin.com" aria-label="LinkedIn" rel="noopener">${ICO.li}</a>
      </div>
      <p class="l-tiny">${v.footerTag}</p>
    </div>
  </div>
</footer>
</body></html>`;
}
