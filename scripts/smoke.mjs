// End-to-end smoke of the money/booking paths against a running server. Usage: node scripts/smoke.mjs [origin]
const O = process.argv[2] || "http://localhost:3000";
let cookie = "";
const j = async (path, init = {}) => {
  const r = await fetch(O + path, { ...init, headers: { Origin: O, "Content-Type": "application/json", cookie, ...(init.headers || {}) } });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label} ${extra}`); if (!cond) process.exitCode = 1; };
const uuid = () => crypto.randomUUID();
// Tue–Fri only: every demo barber works those days.
const wd = (from = 3) => { const d = new Date(Date.now() + from * 864e5); while (![2, 3, 4, 5].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

let r = await j("/api/sandbox/auth/login", { method: "POST", body: JSON.stringify({ email: "owner@demo.test", password: "Demo1234!" }) });
ok("owner login", r.status === 200, JSON.stringify(r.body).slice(0, 60));
const w = (await j("/api/sandbox/workspace")).body;
ok("workspace", !!w.shop, `${w.staff?.length} staff, ${w.services?.length} services, ${w.bookings?.length} bookings`);
const svc = w.services.find((s) => s.duration_min === 30);
const date = wd();
// Pick real free slots from availability rather than guessing around seeded appointments.
const avail = (await j(`/api/sandbox/availability?date=${date}&staff_id=${w.staff[0].id}&service_id=${svc.id}`)).body;
const free = (avail.slots || []).filter((x) => x.reason === "").map((x) => x.start_min);
ok("availability has free slots", free.length >= 3, `${free.length} free on ${date}`);
const [slotA, slotB] = [free[0], free.find((m) => m > free[0] + 60) ?? free[2]];
const payload = { request_id: uuid(), staff_id: w.staff[0].id, service_id: svc.id, customer_name: "Postgres Pat", phone: "07700900777", notes: "smoke", date, start_min: slotA, source: "TEST_BOOKING", quote: { service_version: svc.version, shop_version: w.shop.version } };
r = await j("/api/sandbox/bookings", { method: "POST", body: JSON.stringify(payload) });
ok("create booking", r.status === 201, r.status === 201 ? r.body.booking.reference : JSON.stringify(r.body).slice(0, 100));
const b = r.body.booking;
r = await j("/api/sandbox/bookings", { method: "POST", body: JSON.stringify({ ...payload, request_id: uuid(), customer_name: "Clash Carl", phone: "07700900778" }) });
ok("overlap rejected by trigger", r.status === 409 && r.body.error === "slot_taken", JSON.stringify(r.body).slice(0, 60));
r = await j("/api/sandbox/bookings", { method: "POST", body: JSON.stringify(payload) });
ok("idempotent replay", r.status === 200 && r.body.replayed === true);
r = await j("/api/sandbox/bookings", { method: "POST", body: JSON.stringify({ ...payload, request_id: uuid(), phone: "07700900779", start_min: slotB, quote: { service_version: svc.version + 5, shop_version: w.shop.version } }) });
ok("stale quote rejected", r.status === 409 && r.body.error === "quote_changed", JSON.stringify(r.body).slice(0, 60));
r = await j(`/api/sandbox/bookings/${b.id}/reschedule`, { method: "POST", body: JSON.stringify({ date, staff_id: b.staff_id, start_min: slotB, version: b.version, reason: "smoke move" }) });
ok("reschedule", r.status === 200, JSON.stringify(r.body).slice(0, 80));
let v = r.body.booking?.version;
for (const st of ["CHECKED_IN", "IN_SERVICE"]) { r = await j(`/api/sandbox/bookings/${b.id}/status`, { method: "POST", body: JSON.stringify({ status: st, reason: "", version: v }) }); v = r.body.booking?.version; ok(`status ${st}`, r.status === 200, JSON.stringify(r.body).slice(0, 60)); }
r = await j(`/api/sandbox/bookings/${b.id}/checkout`, { method: "POST", body: JSON.stringify({ version: v, discount_pence: 0, note: "", complete: true, tenders: [{ method: "CARD", service_pence: b.price_pence, tip_pence: 300 }] }) });
ok("checkout + complete", r.status === 201, JSON.stringify(r.body).slice(0, 90));
r = await j("/api/sandbox/notifications");
ok("review_request queued", r.body.notifications?.some((n) => n.template === "review_request" && n.related_id === b.id));
r = await j(`/api/sandbox/bookings/${b.id}/manage-link`, { method: "POST", body: JSON.stringify({}) });
const token = r.body.token; ok("manage link", r.status === 201 && token?.length === 72);
r = await fetch(`${O}/api/public/manage/${token}`).then((x) => x.json());
ok("manage view (public)", r.booking?.status === "COMPLETED" && r.can_review === true);
r = await j(`/api/public/manage/${token}/review`, { method: "POST", body: JSON.stringify({ rating: 5, body: "Postgres works" }) });
ok("review left", r.status === 201, JSON.stringify(r.body).slice(0, 60));
r = await j(`/api/public/manage/${token}/review`, { method: "POST", body: JSON.stringify({ rating: 4 }) });
ok("second review rejected", r.status === 409);
r = await fetch(`${O}/api/public/shops/${w.shop.slug}/availability?date=${wd(5)}&staff_id=${w.staff[1].id}&service_id=${svc.id}`).then((x) => x.json());
ok("public availability", Array.isArray(r.slots) && r.slots.length > 5, `${r.slots?.length} slots`);
r = await j(`/api/public/shops/${w.shop.slug}/waitlist`, { method: "POST", body: JSON.stringify({ staff_id: null, service_id: svc.id, customer_name: "Wait Wendy", phone: "07700900780", email: "", date: wd(4), daypart: "ANY", notes: "" }) });
ok("waitlist join (upsert)", r.status === 201, JSON.stringify(r.body).slice(0, 60));
r = await j("/api/sandbox/waitlist");
const entry = r.body.waitlist?.find((e) => e.customer_name === "Wait Wendy");
ok("queue lists entry", !!entry);
if (entry) {
  r = await j(`/api/sandbox/waitlist/${entry.id}/matches`);
  ok("matches", Array.isArray(r.body.matches) && r.body.matches.length > 0, `${r.body.matches?.length}`);
  const m = r.body.matches?.[0];
  if (m) { r = await j(`/api/sandbox/waitlist/${entry.id}/offer`, { method: "POST", body: JSON.stringify({ staff_id: m.staff_id, start_min: m.start_min, version: entry.version }) }); ok("offer", r.status === 201, JSON.stringify(r.body).slice(0, 60));
    const ot = r.body.offer?.link?.split("/offer/")[1];
    if (ot) { r = await j(`/api/public/offer/${ot}/accept`, { method: "POST", body: JSON.stringify({}) }); ok("offer accepted → booking", r.status === 201 && !!r.body.booking?.id, JSON.stringify(r.body).slice(0, 60)); }
  }
}
r = await j("/api/sandbox/insights?days=90"); ok("insights", r.status === 200 && r.body.barbers?.length >= 1 && r.body.weekdays?.length >= 1, `${r.body.barbers?.length} barbers`);
r = await j("/api/sandbox/customers?filter=regulars&sort=spend"); ok("customer directory (HAVING/ORDER)", r.status === 200 && r.body.customers?.length > 0, `${r.body.customers?.length}`);
r = await j("/api/sandbox/pay-runs/preview?staff_id=" + w.staff[0].id + "&from=2026-09-01&to=2026-09-14"); ok("pay run preview", r.status === 200, JSON.stringify(r.body).slice(0, 60));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const fd = new FormData(); fd.append("kind", "gallery"); fd.append("file", new Blob([png], { type: "image/png" }), "a.png");
r = await fetch(O + "/api/sandbox/media", { method: "POST", headers: { Origin: O, cookie }, body: fd }).then(async (x) => ({ status: x.status, body: await x.json() }));
ok("media upload", r.status === 201, JSON.stringify(r.body).slice(0, 80));
if (r.body.media) { const g = await fetch(O + r.body.media.url); ok("media served", g.status === 200 && g.headers.get("content-type") === "image/png"); }
const html = await fetch(`${O}/${w.shop.slug}`).then((x) => x.text());
ok("SEO head", html.includes("<title>Northline Barbers · Barbers in London</title>") && html.includes("aggregateRating"));
r = await j("/api/sandbox/auth/login", { method: "POST", body: JSON.stringify({ email: "owner@demo.test", password: "wrong" }) });
ok("bad password → 401 (throttle upsert)", r.status === 401);
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
