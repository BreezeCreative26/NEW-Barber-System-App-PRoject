// Customer CSV import. Owners bring a list from Fresha/Booksy/Square/a spreadsheet; we detect the
// columns, normalise UK mobiles, dedupe on phone against the directory, and show exactly what
// will happen before anything is written. Never overwrites a filled field with a blank.
import { z } from "zod";

export type ImportRow = {
  line: number;
  name: string;
  phone: string;
  email: string;
  notes: string;
  tags: string[];
  birthday: string;
  marketing_opt_in: 0 | 1;
  action: "create" | "update" | "skip" | "invalid";
  reason: string;
  existing_id?: string;
};
export type ImportPreview = {
  columns: string[];
  mapping: Record<string, string | null>; // our field → their header
  rows: ImportRow[];
  counts: { create: number; update: number; skip: number; invalid: number; total: number };
};

// Minimal RFC-4180 parser: quotes, escaped quotes, CRLF, commas/semicolons/tabs (auto-detected).
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].map((d) => [d, (firstLine.match(new RegExp(d === "\t" ? "\t" : `\\${d}`, "g")) || []).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

// Header aliases from the exports we see most.
const ALIASES: Record<string, string[]> = {
  name: ["name", "full name", "client name", "customer name", "client", "customer", "fullname"],
  first_name: ["first name", "firstname", "first", "given name", "forename"],
  last_name: ["last name", "lastname", "last", "surname", "family name"],
  phone: ["phone", "mobile", "mobile number", "phone number", "tel", "telephone", "cell", "contact number", "mobile phone"],
  email: ["email", "e mail", "email address", "mail", "e mail address"],
  notes: ["notes", "note", "comments", "comment", "client notes", "remarks"],
  tags: ["tags", "tag", "labels", "label", "groups", "group", "category"],
  birthday: ["birthday", "date of birth", "dob", "birth date", "birthdate"],
  marketing: ["marketing", "marketing opt in", "marketing consent", "sms marketing", "email marketing", "opt in", "accepts marketing", "consent"],
};
export function detectMapping(headers: string[]): Record<string, string | null> {
  const norm = (h: string) => h.trim().toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ");
  const mapping: Record<string, string | null> = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const hit = headers.find((h) => names.includes(norm(h)));
    mapping[field] = hit ?? null;
  }
  return mapping;
}

export const normalisePhone = (raw: string) => {
  let s = raw.replace(/[\s()\-.]/g, "");
  if (/^44\d{10}$/.test(s)) s = "+" + s;
  if (/^\+447\d{9}$/.test(s)) s = "0" + s.slice(3);
  if (/^7\d{9}$/.test(s)) s = "0" + s;
  return /^07\d{9}$/.test(s) ? s : "";
};
const email = z.string().trim().email().max(254);
const toDate = (raw: string) => {
  const s = raw.trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); // UK d/m/y
  if (m) { const y = m[3].length === 2 ? `19${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return "";
};
const truthy = (raw: string) => /^(1|y|yes|true|opted in|opt in|subscribed|consented)$/i.test(raw.trim());

export function buildRows(records: string[][], headers: string[], mapping: Record<string, string | null>, existing: Map<string, { id: string; name: string; email: string; notes?: string; tags?: string; birthday?: string | null; marketing_opt_in?: number }>): ImportRow[] {
  const idx = (field: string) => (mapping[field] ? headers.indexOf(mapping[field]!) : -1);
  const get = (r: string[], field: string) => { const i = idx(field); return i >= 0 ? (r[i] ?? "").trim() : ""; };
  const seen = new Set<string>();
  return records.map((r, n) => {
    const name = (get(r, "name") || `${get(r, "first_name")} ${get(r, "last_name")}`.trim()).replace(/\s+/g, " ").slice(0, 80);
    const phone = normalisePhone(get(r, "phone"));
    const em = get(r, "email");
    const emailOk = em === "" || email.safeParse(em).success;
    const row: ImportRow = {
      line: n + 2,
      name, phone,
      email: emailOk ? em.toLowerCase() : "",
      notes: get(r, "notes").slice(0, 1000),
      tags: get(r, "tags").split(/[;,|]/).map((t) => t.trim()).filter(Boolean).slice(0, 12).map((t) => t.slice(0, 24)),
      birthday: toDate(get(r, "birthday")),
      marketing_opt_in: truthy(get(r, "marketing")) ? 1 : 0,
      action: "create", reason: "",
    };
    if (!name) { row.action = "invalid"; row.reason = "No name"; return row; }
    if (!phone) { row.action = "invalid"; row.reason = get(r, "phone") ? "Not a UK mobile" : "No mobile number"; return row; }
    if (seen.has(phone)) { row.action = "skip"; row.reason = "Duplicate mobile in this file"; return row; }
    seen.add(phone);
    const ex = existing.get(phone);
    if (ex) {
      row.existing_id = ex.id;
      let exTags: string[] = [];
      try { exTags = JSON.parse(ex.tags || "[]"); } catch { /* ignore */ }
      const adds =
        (!ex.email && row.email) ||
        (row.notes && !(ex.notes || "").includes(row.notes)) ||
        row.tags.some((t) => !exTags.includes(t)) ||
        (row.birthday && !ex.birthday) ||
        (row.marketing_opt_in && !ex.marketing_opt_in);
      row.action = adds ? "update" : "skip";
      row.reason = adds ? `Already here as ${ex.name} — fills blanks only` : `Already here as ${ex.name}`;
    }
    return row;
  });
}
