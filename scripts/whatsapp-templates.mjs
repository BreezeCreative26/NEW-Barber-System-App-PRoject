// Submit OLLO's WhatsApp message templates to the configured Infobip sender and report status.
//   INFOBIP_API_KEY=… INFOBIP_WA_SENDER=447… node scripts/whatsapp-templates.mjs [--submit]
// Without --submit it only lists what the sender has vs what src/server/whatsapp.ts expects.
// The shared Infobip test sender (447860088970) cannot take custom templates — register OLLO's
// own sender in the Infobip portal first (docs/WHATSAPP.md).
import { readFileSync } from "node:fs";
const key = process.env.INFOBIP_API_KEY, sender = (process.env.INFOBIP_WA_SENDER || "").replace(/\D/g, "");
const base = `https://${(process.env.INFOBIP_BASE_URL || "api.infobip.com").replace(/^https?:\/\//, "")}`;
if (!key || !sender) { console.error("usage: INFOBIP_API_KEY=… INFOBIP_WA_SENDER=447… node scripts/whatsapp-templates.mjs [--submit]"); process.exit(1); }
const submit = process.argv.includes("--submit");
const api = async (path, body) => {
  const res = await fetch(base + path, { method: body ? "POST" : "GET", headers: { Authorization: `App ${key}`, "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
};
// Parse WA_TEMPLATES out of the TS source so the two never drift.
const src = readFileSync(new URL("../src/server/whatsapp.ts", import.meta.url), "utf8");
const block = src.slice(src.indexOf("WA_TEMPLATES"), src.indexOf("// Infobip's stock templates"));
const templates = [...block.matchAll(/name: "([a-z_]+)", category: "([A-Z]+)", body: "((?:[^"\\]|\\.)*)"(?:, button: \{ text: "([^"]+)", urlBase: "([^"]+)" \})?/g)]
  .map((m) => ({ name: m[1], category: m[2], body: m[3].replace(/\\"/g, '"'), button: m[4] ? { text: m[4], url: m[5].replace("{{origin}}", process.env.APP_ORIGIN || "https://new-barber-system-app-p-roject.vercel.app") + "{{1}}" } : null }));
const seen = new Set();
const unique = templates.filter((t) => !seen.has(t.name) && seen.add(t.name));
const have = (await api(`/whatsapp/2/senders/${sender}/templates`)).json.templates || [];
for (const t of unique) {
  const h = have.find((x) => x.name === t.name);
  if (h) { console.log(`${t.name.padEnd(28)} ${h.status}`); continue; }
  if (!submit) { console.log(`${t.name.padEnd(28)} NOT_SUBMITTED`); continue; }
  const body = { name: t.name, language: "en_GB", category: t.category, structure: { body: { text: t.body }, ...(t.button ? { buttons: [{ type: "URL", text: t.button.text, url: t.button.url }] } : {}) } };
  const r = await api(`/whatsapp/2/senders/${sender}/templates`, body);
  console.log(`${t.name.padEnd(28)} ${r.ok ? "SUBMITTED" : `ERROR ${r.status} ${r.json.requestError?.serviceException?.text || JSON.stringify(r.json)}`}`);
}
