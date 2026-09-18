// Marketing front door at "/". Server-rendered, no JavaScript needed, indexable. Signed-in owners
// never see it (they land in the workspace). Copy speaks to a UK barbershop owner deciding whether
// to switch from a paper book / Fresha / Booksy; every claim below is something the product does.
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);

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
<meta name="theme-color" content="#181b2a"/>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/>
<link rel="preload" as="image" href="/static/landing/hero-sm.webp" media="(max-width: 767px)"/>
<link rel="preload" as="image" href="/static/landing/hero.webp" media="(min-width: 768px)"/>
<link rel="stylesheet" href="/static/design.css"/>
<link rel="stylesheet" href="/static/landing.css"/>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body class="landing">
<header class="l-header">
  <a class="l-brand" href="/" aria-label="OLLO home"><span class="l-mark" aria-hidden="true">O</span>OLLO</a>
  <nav class="l-nav" aria-label="Site">
    <a href="#features">Features</a>
    <a href="#pricing">Pricing</a>
    <a href="#faq">FAQ</a>
    <a class="l-signin" href="/signin">Sign in</a>
    <a class="l-cta" href="/signup" data-testid="landing-cta-header">Create your shop</a>
  </nav>
</header>

<main id="main">
  <section class="l-hero" aria-labelledby="hero-heading">
    <div class="l-hero-copy">
      <p class="l-eyebrow">Built for barbershops</p>
      <h1 id="hero-heading">Your chairs, booked. Your barbers, paid.</h1>
      <p class="l-lede">Online booking your customers actually use, a calendar you can drag around, deposits that stop no‑shows, and pay runs that add themselves up. Set up in two minutes.</p>
      <div class="l-actions">
        <a class="l-cta l-cta-lg" href="/signup" data-testid="landing-cta-hero">Create your shop — free</a>
        <a class="l-ghost" href="#how">See how it works</a>
      </div>
      <ul class="l-proof" aria-label="Highlights">
        <li>No card needed to start</li>
        <li>Text + email reminders</li>
        <li>Works on any phone</li>
      </ul>
    </div>
    <figure class="l-hero-media">
      <picture>
        <source media="(max-width: 767px)" srcset="/static/landing/hero-sm.webp"/>
        <img src="/static/landing/hero.webp" width="1400" height="1050" alt="A barber mid-cut in a bright shop; a phone on the counter shows the day's bookings." fetchpriority="high"/>
      </picture>
    </figure>
  </section>

  <section class="l-logos" aria-label="Who it's for">
    <p>For independent shops, chair‑rent collectives and multi‑barber teams across the UK.</p>
  </section>

  <section id="features" class="l-features" aria-labelledby="features-heading">
    <h2 id="features-heading">Everything the front desk used to do</h2>
    <div class="l-grid">
      <article class="l-card">
        <h3>Online booking that fills gaps</h3>
        <p>Your own page and link. Customers pick a barber, a service and a time; add‑ons, group bookings and a waiting list that offers freed slots automatically.</p>
      </article>
      <article class="l-card">
        <h3>A calendar you can drag</h3>
        <p>Move an appointment sideways to another barber or down to a new time — it snaps every 15 minutes. Stretch it longer. Undo if you slip. Double‑book on purpose when you need to.</p>
      </article>
      <article class="l-card">
        <h3>Deposits, prepay or pay at the chair</h3>
        <p>Choose per shop or per service. Deposits are refunded automatically when you reprice or cancel, and settle against the right barber's wallet.</p>
      </article>
      <article class="l-card">
        <h3>Pay runs that add themselves up</h3>
        <p>Commission tiers, chair rent, hybrid pay — weekly or monthly. One click to see what each barber is owed, with the deposits and adjustments already folded in.</p>
      </article>
      <article class="l-card">
        <h3>Block time, tell the customer</h3>
        <p>Barbers block their own lunch, training or sick days. Anyone affected is listed with how they like to be contacted; move them to the next free slot, cancel and refund, or keep them.</p>
      </article>
      <article class="l-card">
        <h3>Reminders that arrive</h3>
        <p>Confirmation, 24‑hour and 2‑hour reminders by text and email, branded as your shop. Customers manage their own visit from a private link — no phone tag.</p>
      </article>
    </div>
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
    <h2 id="pricing-heading">Simple pricing</h2>
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
    <h2 id="final-heading">Ready when you are</h2>
    <p>Two minutes to set up. Your first booking could be today.</p>
    <a class="l-cta l-cta-lg" href="/signup" data-testid="landing-cta-final">Create your shop — free</a>
    <p class="l-tiny">Already have a shop? <a href="/signin">Sign in</a></p>
  </section>
</main>

<footer class="l-footer">
  <span>© ${new Date().getFullYear()} OLLO</span>
  <nav aria-label="Legal"><a href="/signin">Sign in</a><a href="/signup">Create your shop</a></nav>
</footer>
</body></html>`;
}
