// Marketing front door at "/". Server-rendered, zero JavaScript, indexable. Signed-in owners never
// see it (they land in the workspace). Layout and copy follow the OLLO brand mockup: dark green /
// cream bands, "Built by barbers. For the industry.", six features, four steps, fixed-fee comparison,
// testimonials, FAQ. Device mocks are pure CSS; photos are our own generated assets.
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);

// Inline icons (stroke = currentColor) so the page stays script-free and one request.
const svg = (d: string, extra = "") => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const ICO = {
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
export type Vertical = {
  slug: "" | "barbers";
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
};

const BARBER_QUOTES: Quote[] = [
  { img: "dan", name: "Dan", role: "Barber Shop Owner", where: "London", quote: "OLLO has completely changed the way we run our shop. It’s simple, reliable and our clients love the WhatsApp confirmations." },
  { img: "jess", name: "Jess", role: "Hairdresser", where: "Manchester", quote: "We tried a few booking systems and OLLO is by far the best. It’s so easy to use and knowing exactly what we pay each month is a game-changer." },
  { img: "sam", name: "Sam", role: "Salon Owner", where: "Birmingham", quote: "The support team are unreal. They helped us move everything across from our old system and made it stress free." },
  { img: "ria", name: "Ria", role: "Barber", where: "Leeds", quote: "Finally a booking system that actually understands the industry. Made by people who get it." },
];

const BARBER_FAQS: Faq[] = [
  { q: "Do my customers need an app?", a: "No. They book from your link in any browser, get a text, WhatsApp or email with a private link, and can move or cancel from there." },
  { q: "Can I bring my existing customers over?", a: "Yes — import a CSV from your old system in Settings → Customers and their history comes with them." },
  { q: "Do barbers get their own login?", a: "Yes. Invite each barber; they see their own day, take payments at the chair, block their own time and watch their wallet." },
  { q: "What about deposits and no‑shows?", a: "Set a deposit, ask for full prepayment, or let people pay at the chair — shop‑wide or per service. No‑shows can be charged; refunds are automatic when you cancel on them." },
  { q: "What does it really cost?", a: "£24.99 a month, which includes your first barber. Each extra chair is £7.99 — so a three-chair shop pays £40.97. Texts are 6p, WhatsApp 3p, email is free. Card payments are optional at 2.2% + 20p all in; leave them off and pay nothing. The AI Concierge is an optional £49 a month. Nothing per booking, no commission, and you can see exactly what you’ve used in your settings." },
  { q: "Is my data safe?", a: "Hosted in the EU, encrypted in transit, backed up daily. You can export everything at any time." },
];

const UNIVERSAL_QUOTES: Quote[] = [
  { img: "dan", name: "Dan", role: "Barbershop Owner", where: "London", quote: "OLLO has completely changed the way we run our shop. It’s simple, reliable and our clients love the WhatsApp confirmations." },
  { img: "jess", name: "Jess", role: "Beauty Studio Owner", where: "Manchester", quote: "We tried a few booking systems and OLLO is by far the best. It’s so easy to use and knowing exactly what we pay each month is a game-changer." },
  { img: "sam", name: "Sam", role: "Tattoo Artist", where: "Birmingham", quote: "Deposits sorted my no-show problem in a week. The support team helped us move everything across and made it stress free." },
  { img: "ria", name: "Ria", role: "Personal Trainer", where: "Leeds", quote: "My clients book their sessions themselves now and I stopped losing evenings to admin. Made by people who get it." },
];
const UNIVERSAL_FAQS: Faq[] = [
  { q: "Is OLLO right for my kind of business?", a: "If people book a time with you or your team, yes — barbers, salons, beauty and nails, tattoo studios, clinics, personal trainers, therapists, dog groomers, tutors and more. Services, durations, deposits and reminders are all yours to set." },
  { q: "Do my customers need an app?", a: "No. They book from your link in any browser, get a text, WhatsApp or email with a private link, and can move or cancel from there." },
  { q: "Can I bring my existing customers over?", a: "Yes — import a CSV from your old system in Settings → Customers and their history comes with them." },
  { q: "Does each team member get their own login?", a: "Yes. Invite each person; they see their own day, take payments, block their own time and watch their earnings." },
  { q: "What about deposits and no‑shows?", a: "Set a deposit, ask for full prepayment, or let people pay on the day — business‑wide or per service. No‑shows can be charged; refunds are automatic when you cancel on them." },
  { q: "What does it really cost?", a: "£24.99 a month, which includes your first team member. Each extra seat is £7.99 — so a team of three pays £40.97. Texts are 6p, WhatsApp 3p, email is free. Card payments are optional at 2.2% + 20p all in; leave them off and pay nothing. The AI Concierge is an optional £49 a month. Nothing per booking, no commission." },
  { q: "Is my data safe?", a: "Hosted in the EU, encrypted in transit, backed up daily. You can export everything at any time." },
];

export const VERTICALS: Record<"universal" | "barbers", Vertical> = {
  universal: {
    slug: "",
    path: "/",
    title: "OLLO — Booking software for appointment businesses. One fair price, no commission.",
    description: "Online booking, a drag-and-drop calendar, deposits, card payments, team pay and reminders by text, WhatsApp and email — for barbers, salons, beauty, tattoo, clinics, trainers and any business that runs on appointments. Set up in two minutes. Free to start.",
    audience: "Small appointment-based businesses",
    heroEyebrow: "Booking software for any appointment business",
    heroH1: "Built for people<br/>who run on appointments.",
    heroLede: "OLLO is the all-in-one booking system for barbers, salons, beauty studios, tattoo artists, clinics, trainers and anyone whose day is a diary. One clear monthly price, WhatsApp confirmations and everything you need to run the business — without the commission and hidden fees.",
    heroImg: { src: "/static/landing/hero-universal.webp", small: "/static/landing/hero-universal-sm.webp", alt: "A studio owner at her reception desk checking bookings on her phone" },
    everythingLede: "From the first click to the final invoice, OLLO keeps your business running smoothly. Manage bookings, clients, staff, payments and more — all in one easy-to-use platform.",
    whyH2: "We listened to the people doing the work.<br/>Then we built what they wanted.",
    whyLede: "OLLO started behind a barber’s chair, after 20 years of using every booking system on the market. It turned out every appointment business had the same complaints: commission, per-booking fees, and software that gets in the way. So we built the system we all wanted.",
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
    finalH2: "Join the barbers, salons, studios and clinics already running on OLLO.",
    footerTag: "Built by the trade. For every trade.",
    industries: [
      { name: "Barbers", blurb: "Where OLLO started. Chairs, walk-ins, pay at the chair.", href: "/barbers", icon: "scissors" },
      { name: "Hair & salons", blurb: "Colour, cuts, long services and split appointments.", icon: "sparkle" },
      { name: "Beauty & nails", blurb: "Deposits, add-ons and packed-out Saturdays.", icon: "sparkle" },
      { name: "Tattoo & piercing", blurb: "Consults, sittings and deposits that stick.", icon: "pen" },
      { name: "Clinics & therapists", blurb: "Client notes, intake and reminders that cut no-shows.", icon: "heart" },
      { name: "Trainers & coaching", blurb: "Sessions, blocks and clients who book themselves.", icon: "bolt" },
    ],
  },
  barbers: {
    slug: "barbers",
    path: "/barbers",
    title: "OLLO for Barbers — Built by barbers. For the industry. Barbershop booking software",
    description: "Barbershop booking software: online booking, a drag-and-drop calendar, deposits and pay-at-the-chair, barber pay runs, reminders by text, WhatsApp and email. Set up your shop in two minutes. Free to start.",
    audience: "Barbershops and independent barbers",
    heroEyebrow: "Booking software for barbers, hairdressers &amp; salons",
    heroH1: "Built by barbers.<br/>For the industry.",
    heroLede: "OLLO is the all-in-one booking system designed specifically for barbers, hairdressers and salons. With one clear monthly price, WhatsApp confirmations and everything you need to run your shop — we’ve taken the best bits from other platforms and removed all the things you don’t want.",
    heroImg: { src: "/static/landing/hero-barber.webp", small: "/static/landing/hero-barber-sm.webp", alt: "A barber cutting a client’s hair" },
    everythingLede: "From the first click to the final cut, OLLO keeps your shop running smoothly. Manage bookings, clients, barbers, payments and more — all in one easy-to-use platform.",
    whyH2: "We listened to the industry.<br/>Then we built what we wanted.",
    whyLede: "After 20 years behind the chair, we’ve used almost every booking system on the market. We loved some things, we hated others. So we created OLLO — a complete system built by barbers, for barbers, hairdressers and salon owners.",
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
    finalH2: "Join hundreds of barbers, hairdressers and salons already using OLLO.",
    footerTag: "Built by barbers. For the industry.",
  },
};

export function landingPage(origin: string, v: Vertical = VERTICALS.universal) {
  const { title, description } = v;
  const ld = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "OLLO",
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
<meta property="og:type" content="website"/><meta property="og:site_name" content="OLLO"/>
<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/>
<meta property="og:url" content="${esc(origin)}${v.path === "/" ? "/" : v.path}"/><meta property="og:image" content="${esc(origin)}${v.heroImg.src}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="theme-color" content="#0b1a17"/>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/>
<link rel="stylesheet" href="/static/design.css"/>
<link rel="stylesheet" href="/static/landing.css"/>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body class="landing">
<header class="l-header">
  <div class="l-wrap l-header-in">
    <a class="l-brand" href="/" aria-label="OLLO home"><img src="/static/brand/ollo-wordmark.svg" alt="OLLO" width="118" height="34"/></a>
    <nav class="l-nav" aria-label="Site">
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="#about">About</a>
      ${v.industries ? `<a href="#industries">Industries</a>` : `<a href="/">All industries</a>`}
      <a href="#faq">FAQ</a>
    </nav>
    <div class="l-header-cta">
      <a class="l-signin" href="/signin">Sign in</a>
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
          <li><i class="l-ico">${ICO.chat}</i>WhatsApp Integration</li>
          <li><i class="l-ico">${ICO.slash}</i>No Hidden Costs</li>
        </ul>
        ${v.industries ? `<a class="l-hero-vertical" href="/barbers">${ICO.scissors} Run a barbershop? <b>See OLLO for barbers →</b></a>` : `<a class="l-hero-vertical" href="/">${ICO.check} Not a barber? <b>OLLO works for every appointment business →</b></a>`}
      </div>
      <div class="l-hero-visual">
        <picture>
          <source media="(max-width: 720px)" srcset="${v.heroImg.small}"/>
          <img class="l-hero-photo" src="${v.heroImg.src}" alt="${esc(v.heroImg.alt)}" width="768" height="1024" fetchpriority="high"/>
        </picture>
        <div class="l-phone l-phone-hero" role="img" aria-label="A WhatsApp confirmation from OLLO: appointment confirmed for Friday 15th May at 11:30am with Sam.">
          <div class="l-phone-top"><img src="/static/brand/ollo-wordmark.svg" alt="" width="60" height="17"/></div>
          <div class="l-phone-card">
            <b>Appointment Confirmed!</b>
            <p>Hi Jake, your appointment is confirmed for <strong>Friday 15th May at 11:30am</strong> with <strong>Sam</strong>.</p>
            <p>See you soon!<br/>— The team at OLLO</p>
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
        <div class="l-laptop" role="img" aria-label="The OLLO calendar on a laptop: a week of colour-coded appointments across the team.">
          <div class="l-laptop-screen">
            <div class="l-cal-side"><img src="/static/brand/ollo-mark.svg" alt="" width="18" height="18"/><span class="on">Calendar</span><span>Clients</span><span>Team</span><span>Payments</span><span>Reports</span><span>Settings</span></div>
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
          <div class="l-phone-top"><img src="/static/brand/ollo-wordmark.svg" alt="" width="52" height="15"/></div>
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

  <!-- 3. Why OLLO -->
  <section id="why" class="l-dark l-why" aria-labelledby="why-heading">
    <div class="l-wrap l-two l-two-wide">
      <div>
        <p class="l-eyebrow">Why OLLO?</p>
        <h2 id="why-heading">${v.whyH2}</h2>
        <p class="l-lede">${v.whyLede}</p>
        <p class="l-script" aria-hidden="true">${v.script}</p>
      </div>
      <ul class="l-grid6">
        <li><i class="l-ico">${ICO.pound}</i><b>Fair Monthly Price</b><p>From £24.99 a month. Never a fee per booking, never a cut of your clients.</p></li>
        <li><i class="l-ico">${ICO.people}</i><b>Client Management</b><p>Keep track of appointments, notes, preferences and more.</p></li>
        <li><i class="l-ico">${ICO.chat}</i><b>WhatsApp Integration</b><p>Confirmations, reminders and client communication — all via WhatsApp.</p></li>
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
        <div class="l-phone l-phone-wa" role="img" aria-label="A WhatsApp message from OLLO confirming an appointment.">
          <div class="l-phone-top l-phone-top-wa"><img src="/static/brand/ollo-mark.svg" alt="" width="22" height="22"/><b>OLLO</b><small>online</small></div>
          <div class="l-wa-bubble">
            <p>Hi Jake,<br/>Your appointment is confirmed for <strong>Friday 15th May at 11:30am</strong> with <strong>Sam</strong>.</p>
            <p>See you soon!<br/>— The team at OLLO</p>
            <span class="l-phone-btn l-phone-btn-light">View Details</span>
            <time>11:02</time>
          </div>
        </div>
      </div>
      <div>
        <p class="l-eyebrow">See it in action</p>
        <h2 id="action-heading">${v.actionH2}</h2>
        <p class="l-lede">Fast. Simple. No faff. Whether it’s a new booking, rebooking or a last-minute slot — OLLO makes it easy for your clients and your team.</p>
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
          <p class="l-compare-h"><img src="/static/brand/ollo-wordmark.svg" alt="OLLO" width="76" height="22"/></p>
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
              <p>Text confirmations and reminders 6p each. WhatsApp 3p each. Email always free. Your clients choose how they hear from you.</p>
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
        <p class="l-lede l-lede-center">Same calendar, same fair price. Pick your trade to see how shops like yours use OLLO.</p>
      </div>
      <ul class="l-industries-grid">
        ${v.industries.map((i) => `<li class="${i.href ? "l-ind-link" : ""}">${i.href ? `<a href="${i.href}">` : "<div>"}<i class="l-ico">${ICO[i.icon as keyof typeof ICO] || ICO.check}</i><b>${esc(i.name)}</b><p>${esc(i.blurb)}</p>${i.href ? `<span class="l-ind-more">See OLLO for ${esc(i.name.toLowerCase())} →</span></a>` : "</div>"}</li>`).join("")}
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
      <a class="l-brand" href="/" aria-label="OLLO home"><img src="/static/brand/ollo-wordmark.svg" alt="OLLO" width="96" height="28"/></a>
      <p class="l-tiny">© ${new Date().getFullYear()} OLLO. All rights reserved.</p>
    </div>
    <nav aria-label="Footer"><a href="/">OLLO for every business</a><a href="/barbers">OLLO for barbers</a><a href="#features">Features</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a><a href="/signin">Sign in</a><a href="/signup">Create your shop</a></nav>
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
