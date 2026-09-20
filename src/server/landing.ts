// Marketing front door at "/". Server-rendered, zero JavaScript, indexable. Signed-in owners never
// see it (they land in the workspace). Everything animated below is CSS only: the hero is a mock of
// the real OLLO calendar with an appointment being dragged and snapped, a block appearing, and the
// customer's phone lighting up — so the product is shown, not described. Every claim is something
// the product does today.
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);

// ---- Product mocks (CSS-driven) ----------------------------------------------------------------
// The calendar: three barber columns, hour lines, cards. `.m-drag` is the card that travels; `.m-block`
// fades in; `.m-ghost` is the snap ghost with its time label. Keyframes live in landing.css.
function calendarMock() {
  const hours = ["10:00", "11:00", "12:00", "13:00", "14:00"];
  return `<div class="mock-cal" role="img" aria-label="The OLLO calendar: three barbers side by side, an appointment being dragged to a new time and snapping to the grid, a lunch block appearing.">
  <div class="mock-cal-head">
    <span class="mock-chip mock-chip-on">Today</span>
    <span class="mock-date">Fri 18 Sept</span>
    <span class="mock-team">Scheduled team · 3/3</span>
  </div>
  <div class="mock-cal-staff">
    <span class="mock-gutter"></span>
    <span class="mock-staff"><i class="av av-sage">JC</i>Jay<small>09:30–18:00</small></span>
    <span class="mock-staff"><i class="av av-sand">MR</i>Marcus<small>09:30–18:00</small></span>
    <span class="mock-staff"><i class="av av-blue">DO</i>Dani<small>10:00–18:00</small></span>
  </div>
  <div class="mock-cal-body">
    <div class="mock-times">${hours.map((h) => `<span>${h}</span>`).join("")}</div>
    <div class="mock-col">
      <div class="mock-card c-sage pt-0 ph-2"><b>10:00</b> Ada Lovelace<small>Signature cut · £28</small></div>
      <div class="mock-card c-sage pt-6 ph-2"><b>13:00</b> Tom Reyes<small>Skin fade · £30</small></div>
      <div class="mock-block pt-4 ph-2"><b>⊘ Lunch</b><small>12:00–13:00</small></div>
    </div>
    <div class="mock-col">
      <div class="mock-card c-sand pt-1 ph-2"><b>10:30</b> Kofi Mensah<small>Beard trim · £18</small></div>
      <div class="mock-ghost pt-5 ph-2"><b class="mock-ghost-time">12:30</b><span>Sam Okafor</span></div>
      <div class="mock-card c-sand mock-drag pt-1 ph-2"><b class="mock-drag-time">10:30<i class="t1">11:00</i><i class="t2">11:30</i><i class="t3">12:00</i></b> Sam Okafor<small>Cut &amp; beard · £42</small></div>
    </div>
    <div class="mock-col">
      <div class="mock-card c-blue pt-0 ph-3"><b>10:00</b> Priya Nair<small>Full works · £60</small></div>
      <div class="mock-card c-blue c-done pt-4 ph-2"><b>12:00</b> Leo Grant<small>Hot towel shave · £25 · Paid</small></div>
    </div>
    <div class="mock-now"><span>11:26</span></div>
  </div>
  <div class="mock-toast"><i>✓</i> Moved to 12:30 <u>Undo</u></div>
</div>`;
}

// The customer's phone: booking screen morphs into the confirmation text.
function phoneMock() {
  return `<div class="mock-phone" role="img" aria-label="A customer's phone: picking a time on the shop's booking page, then the confirmation text arriving.">
  <div class="mock-phone-notch"></div>
  <div class="mock-screen mock-screen-book">
    <div class="mock-shop"><i class="av av-ink">NB</i><div><b>Northline Barbers</b><small>Hackney · 4.9 ★</small></div></div>
    <p class="mock-label">Skin fade · 30 min · £30</p>
    <p class="mock-label">With Jay · Sat 20 Sept</p>
    <div class="mock-slots">
      <span>09:30</span><span>10:00</span><span class="on">10:30</span><span>11:00</span><span>13:30</span><span>14:00</span><span>15:30</span><span>16:00</span>
    </div>
    <div class="mock-btn">Book 10:30 · pay £10 deposit</div>
  </div>
  <div class="mock-screen mock-screen-sms">
    <div class="mock-sms-head"><b>Northline Barbers</b><small>Text message</small></div>
    <div class="mock-bubble">You're booked ✂️ Skin fade with Jay, Sat 20 Sept at 10:30. Ref NB-0412. Change or cancel: northline.ollo.app/manage/…</div>
    <div class="mock-bubble mock-bubble-2">Reminder: tomorrow 10:30 with Jay. See you then.</div>
  </div>
</div>`;
}

// Day-in-the-shop beats: small product frames, each one true to a real screen.
function dayBeats() {
  const beats = [
    {
      time: "08:55",
      title: "Booked overnight, from Instagram",
      copy: "Two skin fades and a beard trim landed while you slept. Each customer got a text with a private link to move or cancel — no phone tag at 9am.",
      frame: `<div class="frame frame-list"><div class="row"><i class="av av-sage">JC</i><div><b>10:00 · Ada Lovelace</b><small>Signature cut · £28 · <em>booked online 23:41</em></small></div><span class="pill pill-good">Deposit paid</span></div><div class="row"><i class="av av-sand">MR</i><div><b>10:30 · Sam Okafor</b><small>Cut &amp; beard · £42 · <em>booked online 07:12</em></small></div><span class="pill">Pay at chair</span></div><div class="row"><i class="av av-blue">DO</i><div><b>10:00 · Priya Nair</b><small>Full works · £60 · <em>returning customer</em></small></div><span class="pill pill-good">Prepaid</span></div></div>`,
    },
    {
      time: "12:05",
      title: "Marcus blocks his lunch. Two customers already know.",
      copy: "He blocks 12:00–13:00 from his own phone. OLLO lists who's affected and how they like to be contacted, suggests the next free slot, and sends the texts. You never touched it.",
      frame: `<div class="frame frame-block"><div class="frame-head"><b>Block time · Marcus</b><span>12:00–13:00 · Lunch</span></div><div class="row"><div><b>12:15 · Sam Okafor</b><small>SMS · 07700 900…</small></div><span class="seg"><i class="on">Move</i><i>Cancel</i><i>Keep</i></span></div><div class="row"><div><b>12:45 · Ella Byrne</b><small>Email · ella@…</small></div><span class="seg"><i class="on">Move</i><i>Cancel</i><i>Keep</i></span></div><div class="frame-foot">→ Moved to 13:30 and 14:15 · 2 messages sent</div></div>`,
    },
    {
      time: "15:40",
      title: "A walk-in, paid at the chair, tip and all",
      copy: "Seat them in one tap, take card or cash at the chair, add a tip. The visit is on the calendar, the till and the barber's wallet before they've stood up.",
      frame: `<div class="frame frame-till"><div class="frame-head"><b>Checkout · Walk-in</b><span>Skin fade · £30</span></div><div class="tip-row"><span>No tip</span><span>£2</span><span class="on">£3</span><span>£5</span></div><div class="pay-row"><span class="pay on">Card at chair</span><span class="pay">Cash</span><span class="pay">Pay link</span></div><div class="frame-foot"><b>£33.00</b> · Marcus +£19.80 commission</div></div>`,
    },
    {
      time: "18:10",
      title: "Pay run already knows",
      copy: "Commission tiers, chair rent, hybrid pay — each barber's number is there at close, deposits and refunds already folded in. Weekly or monthly, paid out through Stripe.",
      frame: `<div class="frame frame-pay"><div class="row"><i class="av av-sage">JC</i><div><b>Jay Carter</b><small>Commission 55% → 65% over £1,000</small></div><b class="amt">£412.50</b></div><div class="row"><i class="av av-sand">MR</i><div><b>Marcus Reed</b><small>Chair rent £180/wk</small></div><b class="amt">£298.00</b></div><div class="row"><i class="av av-blue">DO</i><div><b>Dani Okoro</b><small>Hybrid · base + 40%</small></div><b class="amt">£356.20</b></div><div class="frame-foot">Week of 15 Sept · <b>ready to pay</b></div></div>`,
    },
  ];
  return beats
    .map(
      (b, i) => `<article class="beat ${i % 2 ? "beat-flip" : ""}">
  <div class="beat-copy">
    <span class="beat-time">${b.time}</span>
    <h3>${b.title}</h3>
    <p>${b.copy}</p>
  </div>
  <div class="beat-frame">${b.frame}</div>
</article>`,
    )
    .join("");
}

export function landingPage(origin: string) {
  const title = "OLLO — the booking system built for barbershops";
  const description =
    "Barbershop booking software: online booking, a drag-and-drop calendar, deposits and pay-at-the-chair, barber pay runs, reminders by text and email. Set up your shop in two minutes. Free to start.";
  const ld = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "OLLO",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description,
    url: origin,
    offers: { "@type": "Offer", price: "0", priceCurrency: "GBP", description: "Free to set up. Card fees only when you take payments." },
    audience: { "@type": "Audience", audienceType: "Barbershops and independent barbers" },
  };
  return `<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
<link rel="canonical" href="${esc(origin)}/"/>
<meta property="og:type" content="website"/><meta property="og:site_name" content="OLLO"/>
<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/>
<meta property="og:url" content="${esc(origin)}/"/><meta property="og:image" content="${esc(origin)}/static/landing/hero.webp"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="theme-color" content="#0f1120"/>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/>
<link rel="stylesheet" href="/static/design.css"/>
<link rel="stylesheet" href="/static/landing.css"/>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body class="landing">
<header class="l-header">
  <a class="l-brand" href="/" aria-label="OLLO home"><span class="l-mark" aria-hidden="true">O</span>OLLO</a>
  <nav class="l-nav" aria-label="Site">
    <a href="#day">A day with OLLO</a>
    <a href="#customers">Your customers</a>
    <a href="#pricing">Pricing</a>
    <a href="#faq">FAQ</a>
    <a class="l-signin" href="/signin">Sign in</a>
    <a class="l-cta" href="/signup" data-testid="landing-cta-header">Create your shop</a>
  </nav>
</header>

<main id="main">
  <section class="l-hero" aria-labelledby="hero-heading">
    <div class="l-hero-bg" aria-hidden="true"></div>
    <div class="l-hero-inner">
      <div class="l-hero-copy">
        <p class="l-eyebrow">Built for barbershops</p>
        <h1 id="hero-heading">Your chairs, booked.<br/>Your barbers, paid.</h1>
        <p class="l-lede">Online booking your customers actually use, a calendar you can drag around, deposits that stop no‑shows, and pay runs that add themselves up. Set up in two minutes.</p>
        <div class="l-actions">
          <a class="l-cta l-cta-lg" href="/signup" data-testid="landing-cta-hero">Create your shop — free</a>
          <a class="l-ghost" href="#day">See a day with OLLO</a>
        </div>
        <ul class="l-proof" aria-label="Highlights">
          <li>No card needed to start</li>
          <li>Text + email reminders</li>
          <li>Works on any phone</li>
        </ul>
      </div>
      <div class="l-hero-media">
        ${calendarMock()}
      </div>
    </div>
  </section>

  <section class="l-strip" aria-label="Who it's for">
    <p>For independent shops, chair‑rent collectives and multi‑barber teams across the UK. Built with barbers in Hackney, Manchester and Glasgow.</p>
  </section>

  <section id="day" class="l-day" aria-labelledby="day-heading">
    <div class="l-section-head">
      <p class="l-eyebrow">A day with OLLO</p>
      <h2 id="day-heading">The front desk you don't have to hire</h2>
      <p class="l-sub">Four moments from an ordinary Friday. Every screen here is the real product.</p>
    </div>
    <div class="beats">
      ${dayBeats()}
    </div>
  </section>

  <section id="customers" class="l-customers" aria-labelledby="customers-heading">
    <div class="l-customers-copy">
      <p class="l-eyebrow">What your customers see</p>
      <h2 id="customers-heading">A booking page they'll actually use</h2>
      <p>Your own link — in your Instagram bio, on Google, on the door. Pick a barber, a service, a time. Pay a deposit, prepay, or pay at the chair: your rule, per shop or per service. A text with a private link lets them move or cancel themselves.</p>
      <ul class="l-checks">
        <li>Group bookings and add‑ons</li>
        <li>Waiting list that offers freed slots automatically</li>
        <li>24‑hour and 2‑hour reminders, branded as your shop</li>
        <li>Their own history and repeat‑booking in one tap</li>
      </ul>
      <a class="l-cta" href="/signup" data-testid="landing-cta-customers">Get your booking link</a>
    </div>
    <div class="l-customers-media">${phoneMock()}</div>
  </section>

  <section id="how" class="l-how" aria-labelledby="how-heading">
    <h2 id="how-heading">Live in two minutes</h2>
    <ol class="l-steps">
      <li><strong>Create your shop.</strong> Name, your name, email, password. You're the first barber; add the rest from Team.</li>
      <li><strong>Add your services and hours.</strong> Prices, lengths, add‑ons. Weekly hours with per‑day overrides when life happens.</li>
      <li><strong>Share your booking link.</strong> Put it in your Instagram bio and on Google. Bookings land on your calendar with a text to the customer.</li>
    </ol>
    <a class="l-cta" href="/signup" data-testid="landing-cta-how">Start now</a>
  </section>

  <section id="pricing" class="l-pricing" aria-labelledby="pricing-heading">
    <div class="l-section-head">
      <p class="l-eyebrow">Pricing</p>
      <h2 id="pricing-heading">Simple pricing</h2>
    </div>
    <div class="l-price">
      <p class="l-price-big">Free to set up</p>
      <p>Unlimited barbers, services and bookings while you get going. Card payments carry the standard processing fee only. Text messages are billed at cost once you switch them on.</p>
      <a class="l-cta" href="/signup" data-testid="landing-cta-pricing">Create your shop</a>
    </div>
  </section>

  <section id="faq" class="l-faq" aria-labelledby="faq-heading">
    <h2 id="faq-heading">Questions barbers ask</h2>
    <details><summary>Do my customers need an app?</summary><p>No. They book from your link in any browser, get a text or email with a private link, and can move or cancel from there.</p></details>
    <details><summary>Can I bring my existing customers over?</summary><p>Yes — import a CSV from your old system in Settings → Customers and their history comes with them.</p></details>
    <details><summary>Do barbers get their own login?</summary><p>Yes. Invite each barber; they see their own day, take payments at the chair, block their own time and watch their wallet.</p></details>
    <details><summary>What about deposits and no‑shows?</summary><p>Set a deposit, ask for full prepayment, or let people pay at the chair — shop‑wide or per service. No‑shows can be charged; refunds are automatic when you cancel on them.</p></details>
    <details><summary>Is my data safe?</summary><p>Hosted in the EU, encrypted in transit, backed up daily. You can export everything at any time.</p></details>
  </section>

  <section class="l-final" aria-labelledby="final-heading">
    <div class="l-final-bg" aria-hidden="true"></div>
    <h2 id="final-heading">Ready when you are</h2>
    <p>Two minutes to set up. Your first booking could be today.</p>
    <a class="l-cta l-cta-lg l-cta-light" href="/signup" data-testid="landing-cta-final">Create your shop — free</a>
    <p class="l-tiny">Already have a shop? <a href="/signin">Sign in</a></p>
  </section>
</main>

<footer class="l-footer">
  <span>© ${new Date().getFullYear()} OLLO</span>
  <nav aria-label="Legal"><a href="/signin">Sign in</a><a href="/signup">Create your shop</a></nav>
</footer>
</body></html>`;
}
