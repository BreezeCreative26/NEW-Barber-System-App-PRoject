// Stand-in for Vercel's domains API and Resend's domains + send API, for local end-to-end runs of the
// "your own web address" feature. Nothing here talks to a real provider or sends a real message.
//   node tests/support/provider-stub.mjs [port]      (default 4010)
// Control: POST /_ctl/verify {domain} · POST /_ctl/reject {on} · GET /_ctl/emails · POST /_ctl/reset
import http from "node:http";

const port = Number(process.argv[2] || 4010);
let vercel = new Map(); // domain -> { verified, configured }
let resend = new Map(); // id -> { name, status }
let emails = [];
let rejectCustom = false;
let seq = 0;

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } }); });
const vdom = (name) => ({ name, apexName: name.split(".").slice(-2).join("."), verified: vercel.get(name)?.verified ?? false, verification: vercel.get(name)?.verified ? [] : [{ type: "TXT", domain: `_vercel.${name}`, value: "vc-domain-verify=stub", reason: "pending" }] });
const records = (name, st) => [
  { record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=STUBKEY", status: st, ttl: "Auto" },
  { record: "SPF", name: "send", type: "MX", value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10, status: st, ttl: "Auto" },
  { record: "SPF", name: "send", type: "TXT", value: "v=spf1 include:amazonses.com ~all", status: st, ttl: "Auto" },
];

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const m = req.method;
  const b = m === "GET" || m === "DELETE" ? {} : await readBody(req);

  if (p === "/_ctl/verify") { const d = b.domain; vercel.set(d, { verified: true, configured: true }); for (const r of resend.values()) if (r.name === d) r.status = "verified"; return send(res, 200, { ok: true }); }
  if (p === "/_ctl/reject") { rejectCustom = !!b.on; return send(res, 200, { ok: true }); }
  if (p === "/_ctl/emails") return send(res, 200, emails);
  if (p === "/_ctl/reset") { vercel = new Map(); resend = new Map(); emails = []; rejectCustom = false; return send(res, 200, { ok: true }); }

  // ---- Resend: send
  if (p === "/emails" && m === "POST") {
    emails.push(b);
    const domains = [...resend.values()].filter((r) => r.status === "verified").map((r) => r.name);
    const customFrom = /<bookings@([^>]+)>/.exec(b.from || "")?.[1];
    if (customFrom && domains.includes(customFrom) && rejectCustom) return send(res, 403, { name: "validation_error", message: "The domain is not verified" });
    return send(res, 200, { id: `em_stub_${++seq}` });
  }
  // ---- Resend: domains
  if (p === "/domains" && m === "POST") { const id = `rd_${++seq}`; resend.set(id, { name: b.name, status: "not_started" }); return send(res, 201, { id, name: b.name }); }
  if (p === "/domains" && m === "GET") return send(res, 200, { data: [...resend].map(([id, r]) => ({ id, name: r.name, status: r.status })) });
  let r = /^\/domains\/([^/]+)(\/verify)?$/.exec(p);
  if (r) {
    const d = resend.get(r[1]);
    if (!d) return send(res, 404, { message: "Domain not found" });
    if (m === "DELETE") { resend.delete(r[1]); return send(res, 200, { deleted: true }); }
    if (r[2]) { if (d.status === "not_started") d.status = "pending"; return send(res, 200, { object: "domain", id: r[1] }); }
    return send(res, 200, { id: r[1], name: d.name, status: d.status, records: records(d.name, d.status === "verified" ? "verified" : "pending") });
  }
  // ---- Vercel
  if (/^\/v10\/projects\/[^/]+\/domains$/.test(p) && m === "POST") { if (!vercel.has(b.name)) vercel.set(b.name, { verified: false, configured: false }); return send(res, 200, vdom(b.name)); }
  r = /^\/v9\/projects\/[^/]+\/domains\/([^/]+)(\/verify)?$/.exec(p);
  if (r) {
    const name = decodeURIComponent(r[1]);
    if (!vercel.has(name)) return send(res, 404, { error: { code: "not_found", message: "Domain not found" } });
    if (m === "DELETE") { vercel.delete(name); return send(res, 200, {}); }
    return send(res, 200, vdom(name));
  }
  r = /^\/v6\/domains\/([^/]+)\/config$/.exec(p);
  if (r) { const v = vercel.get(decodeURIComponent(r[1])); return send(res, 200, { misconfigured: !v?.configured, recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com." }], recommendedIPv4: [{ rank: 1, value: ["76.76.21.21"] }] }); }
  send(res, 404, { error: { message: `stub: no route ${m} ${p}` } });
}).listen(port, "0.0.0.0", () => console.log(`provider stub on :${port}`));
