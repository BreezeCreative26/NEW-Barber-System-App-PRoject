// Barbers-first marketing: server-rendered, script-free and limited to implemented features.
// Product illustrations are HTML/CSS with labelled sample data, not customer testimonials.
const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const icon = (name: string) => {
  const paths: Record<string, string> = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h3m3 0h2"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m20 4-12 12m6-2 6 6M8 8l4 4"/>',
    people: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-18a3 3 0 0 1 0 6m2 5a5 5 0 0 1 2 4v3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/>',
    wallet: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M16 11h5v5h-5a2.5 2.5 0 0 1 0-5ZM3 8h16"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  };
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.check}</svg>`;
};
export type Vertical = { path: string; title: string; description: string };
const description = "Barbershop appointment software for online bookings, walk-ins, barber calendars, shifts, waiting lists, customer accounts and your own branded booking website.";
export const VERTICALS: Record<"universal" | "barbers", Vertical> = {
  universal: { path: "/", title: "foliyo — Booking software built around your barbershop", description },
  barbers: { path: "/barbers", title: "foliyo for barbers — Your shop. Your team. Your day.", description },
};
const features = [
  ["calendar", "A calendar that works like your shop", "See each barber’s day, drag appointments, track walk-ins and check booked value without leaving the timetable."],
  ["scissors", "Your services. Your way.", "Set services, prices and durations, assign them to barbers and manage individual pricing and extras."],
  ["clock", "Give gaps a waiting list", "Keep requests by service, barber and date range. Find a matching slot and send an offer when space opens."],
  ["people", "Shifts without the guesswork", "Manage weekly hours, breaks, dated changes and time off. Review affected bookings before changing a schedule."],
  ["wallet", "Keep the numbers in view", "Record payments, review daily totals and prepare barber pay runs. Card collection and payouts need connected payment services."],
  ["globe", "A booking website with your name on it", "Add your logo, cover, colours and wording. Preview your page, save a draft and publish when you are ready."],
];
const faqs = [
  ["Is foliyo built for barbers?", "Yes. This starts with barbershop workflows: a column for each barber, walk-ins alongside bookings, service-specific pricing, shifts and barber pay runs. The homepage focuses on that experience rather than promising every industry’s workflow."],
  ["Do customers need to install an app?", "No. Customers can use your booking link in their browser. Supported devices can also add your shop app to the home screen. Sign-in is still required for private account information."],
  ["How do my barbers join?", "Create their team profile and send an invitation. They accept the invitation, set their login details and agree to the relevant terms. Their role determines what they can see and change."],
  ["Can I take deposits and send reminders?", "The app supports payment policies and customer-message settings. Actual card collection, payouts, email, SMS and push delivery depend on connected services and the shop’s configuration. Check availability and fees before enabling them."],
  ["Does the app work offline?", "You need a connection to sign in, see current availability or change bookings. The app does not queue booking changes offline or show a cached private appointment page."],
  ["What does it cost?", "Review the current subscription, staff-seat charges and applicable message and payment fees in Plan & billing and Payments settings. This page does not quote a fixed all-in rate or promise that paid services are included."],
];

function calendarPreview() {
  return `<figure class="l-product" aria-label="Illustrative barbershop calendar">
    <div class="l-product-top"><span class="l-product-mark">f.</span><b>Northline Barbers</b><span class="l-product-date">Monday · Day view</span><span class="l-product-add">＋ New booking</span></div>
    <div class="l-product-body"><div class="l-product-rail" aria-hidden="true">${icon("calendar")}${icon("people")}${icon("scissors")}${icon("wallet")}<span>NL</span></div>
      <div class="l-diary"><div class="l-diary-head"><span>Time</span>${["Jay", "Marcus", "Dani"].map((name, i) => `<div><i class="l-avatar a-${i}">${name[0]}</i><b>${name}</b><small>Today’s appointments</small></div>`).join("")}</div>
      <div class="l-diary-grid"><div class="l-times"><span>09:00</span><span>09:30</span><span>10:00</span><span>10:30</span><span>11:00</span></div>
      <div class="l-chair"><div class="l-appointment ap-mint"><b>Alex M.</b><span>Skin fade</span><small>09:00 · 45 min</small></div><div class="l-appointment ap-blue"><b>Jordan L.</b><span>Cut &amp; beard</span><small>10:00 · 45 min</small></div></div>
      <div class="l-chair"><div class="l-appointment ap-lilac"><b>Sam T.</b><span>Signature cut</span><small>09:00 · 30 min</small></div><div class="l-gap"><span>Space in the diary</span><b>Check waiting list ${icon("arrow")}</b></div></div>
      <div class="l-chair"><div class="l-appointment ap-blue"><b>Riley C.</b><span>Cut &amp; style</span><small>09:30 · 30 min</small></div><div class="l-appointment ap-mint"><b>Walk-in</b><span>Beard tidy</span><small>10:30 · 20 min</small></div></div></div></div>
    </div><figcaption>Illustrative shop data · not a live calendar</figcaption>
  </figure>`;
}
export function landingPage(origin: string, v: Vertical = VERTICALS.universal) {
  const canonical = `${origin}${v.path}`;
  const ld = { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "foliyo", applicationCategory: "BusinessApplication", operatingSystem: "Web", description: v.description, url: canonical, audience: { "@type": "Audience", audienceType: "Barbershops and independent barbers" } };
  const cta = (id: string, text = "Create your shop") => `<a class="l-btn l-btn-green" href="/signup" data-testid="${id}">${text} ${icon("arrow")}</a>`;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(v.title)}</title><meta name="description" content="${esc(v.description)}"/><link rel="canonical" href="${esc(canonical)}"/>
<meta property="og:type" content="website"/><meta property="og:title" content="${esc(v.title)}"/><meta property="og:description" content="${esc(v.description)}"/><meta property="og:url" content="${esc(canonical)}"/>
<meta name="theme-color" content="#101b18"/><link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/><link rel="manifest" href="/site.webmanifest"/>
<link rel="stylesheet" href="/static/design.css"/><link rel="stylesheet" href="/static/landing.css"/>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script></head>
<body class="landing"><a class="l-skip" href="#main">Skip to content</a>
<header class="l-header"><div class="l-wrap l-header-in"><a class="l-brand" href="/" aria-label="foliyo home"><img src="/static/brand/foliyo-wordmark-white.svg" width="100" height="38" alt="foliyo"/></a>
<nav class="l-nav" aria-label="Site"><a href="#features">Features</a><a href="#apps">For your team</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></nav><div class="l-header-cta"><a href="/signin" class="l-signin">Sign in</a>${cta("landing-cta-header", "Get started")}</div></div></header>
<main id="main"><section class="l-hero" aria-labelledby="hero-heading"><div class="l-wrap"><div class="l-hero-copy"><p class="l-eyebrow"><span class="l-dot"></span> Built around the barbershop</p>
<h1 id="hero-heading">Less admin.<br/><span>More time behind the chair.</span></h1><p class="l-lede">Bookings, walk-ins, your team and your shop’s website. One place to keep the day moving, so you can get on with the cut.</p>
<div class="l-ctas">${cta("landing-cta-hero")}<a class="l-text-link" href="#features">Explore the features ${icon("arrow")}</a></div>
<p class="l-hero-note">Your shop. Your barbers. Your brand.</p></div>${calendarPreview()}</div></section>
<div class="l-capabilities"><div class="l-wrap">${[["calendar","Online bookings"],["scissors","Walk-ins welcome"],["people","Barber-by-barber calendars"],["globe","Your own booking website"]].map(([i,t])=>`<span>${icon(i)}${t}</span>`).join("")}</div></div>
<section id="features" class="l-light l-section" aria-labelledby="features-heading"><div class="l-wrap"><div class="l-section-head"><div><p class="l-eyebrow">Made for the working day</p><h2 id="features-heading">The whole shop.<br/>One clear view.</h2></div><p>From the first booking to the last walk-in, keep the details together without making the day more complicated.</p></div>
<div class="l-feature-grid">${features.map(([i,t,b],n)=>`<article class="l-feature"><span class="l-feature-icon">${icon(i)}</span><span class="l-feature-index">0${n+1}</span><h3>${t}</h3><p>${b}</p></article>`).join("")}</div></div></section>
<section id="apps" class="l-apps l-section" aria-labelledby="apps-heading"><div class="l-wrap"><div class="l-center"><p class="l-eyebrow">Different roles. Same shop.</p><h2 id="apps-heading">A place for everyone.<br/>Not the same access for everyone.</h2><p>Use the browser or add the app to a supported home screen. The login and permissions follow the person, not the icon.</p></div>
<div class="l-app-grid"><article class="l-app-card"><span class="l-role">01 / Shop owner</span><h3>See the bigger picture.</h3><p>Set up the shop, manage the full calendar, services, team access, website and business settings.</p><ul><li>${icon("check")} Guided shop setup</li><li>${icon("check")} Shop-wide calendar and totals</li><li>${icon("check")} Roles and invitations</li></ul><a href="/signup">Create an owner account ${icon("arrow")}</a></article>
<article class="l-app-card"><span class="l-role">02 / Barber</span><h3>Know your next move.</h3><p>Join through your shop’s invitation. View your day, manage your visits and use the tools permitted by your role.</p><ul><li>${icon("check")} Your own appointment column</li><li>${icon("check")} Availability and time blocks</li><li>${icon("check")} Your pay-run information</li></ul><a href="/signin">Already invited? Sign in ${icon("arrow")}</a></article>
<article class="l-app-card"><span class="l-role">03 / Customer</span><h3>Book. Come back. Repeat.</h3><p>Choose a service, barber and time from your shop’s link. Sign in to see visits and manage eligible bookings.</p><ul><li>${icon("check")} Your shop’s name and colours</li><li>${icon("check")} Verified mobile at sign-up</li><li>${icon("check")} Browser booking, app optional</li></ul><p class="l-customer-note">Customers join through their barbershop’s booking link.</p></article></div>
<p class="l-security-note">${icon("shield")} A connection is required for private records and booking changes. Installing the app does not bypass sign-in.</p></div></section>
<section id="about" class="l-light l-section" aria-labelledby="setup-heading"><div class="l-wrap l-setup"><div><p class="l-eyebrow">Make it your shop</p><h2 id="setup-heading">Start with the basics.<br/>Build from there.</h2><p class="l-lede">A guided setup for your details, brand, hours, services and team. Save your progress and return when you are ready.</p>${cta("landing-cta-setup")}</div>
<ol class="l-steps"><li><span>01</span><div><h3>Add your shop</h3><p>Set your name, contact details, timezone, logo and cover.</p></div></li><li><span>02</span><div><h3>Shape your diary</h3><p>Set opening hours, services and prices. Review each barber’s shifts.</p></div></li><li><span>03</span><div><h3>Invite the team</h3><p>Create profiles and choose the right access for each person.</p></div></li><li><span>04</span><div><h3>Share your booking link</h3><p>Preview your website, set booking rules and switch online booking on.</p></div></li></ol></div></section>
<section id="pricing" class="l-pricing l-section" aria-labelledby="pricing-heading"><div class="l-wrap l-pricing-in"><div><p class="l-eyebrow">Know what you are switching on</p><h2 id="pricing-heading">Your setup.<br/>Clear choices.</h2><p>Review the current plan, staff-seat charges and payment fees in your workspace. Connected services have their own availability and costs.</p>${cta("landing-cta-pricing-main")}</div><div class="l-cost-list"><article><span>${icon("calendar")}</span><div><h3>Shop subscription</h3><p>Check your plan and staff-seat pricing in Plan &amp; billing.</p></div></article><article><span>${icon("phone")}</span><div><h3>Messages &amp; notifications</h3><p>Configure channels and review SMS charges. Sending requires connected providers.</p></div></article><article><span>${icon("wallet")}</span><div><h3>Card payments &amp; payouts</h3><p>Review applicable fees and complete payment-provider onboarding before taking cards.</p></div></article></div></div></section>
<section id="faq" class="l-light l-section" aria-labelledby="faq-heading"><div class="l-wrap l-faq-in"><div><p class="l-eyebrow">A few useful answers</p><h2 id="faq-heading">Before you<br/>pull up a chair.</h2></div><div>${faqs.map(([q,a])=>`<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div></div></section>
<section class="l-final l-section" aria-labelledby="final-heading"><div class="l-wrap"><p class="l-eyebrow">Barbers first. Your shop next.</p><h2 id="final-heading">Give your day<br/>a better place to run.</h2>${cta("landing-cta-final")}<p>Set up your shop. Preview it. Go live when you are ready.</p></div></section></main>
<footer class="l-footer"><div class="l-wrap l-footer-in"><div><a class="l-brand" href="/" aria-label="foliyo home"><img src="/static/brand/foliyo-wordmark-white.svg" width="100" height="38" alt="foliyo"/></a><p>Built around the barbershop.</p><small>© ${new Date().getFullYear()} foliyo</small></div><nav aria-label="Footer"><a href="#features">Features</a><a href="#apps">Owner, barber &amp; customer apps</a><a href="/barbers">Foliyo for barbers</a><a href="/signin">Sign in</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/dpa">Data processing</a><a href="/legal/cookies">Cookies</a></nav></div></footer></body></html>`;
}
