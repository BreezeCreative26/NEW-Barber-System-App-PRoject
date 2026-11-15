// Text-message encoding. A text made only of the basic GSM-7 alphabet fits 160 characters per part
// (153 once it is split); a single character outside it (a long dash, a curly apostrophe from a phone
// keyboard) switches the WHOLE message to unicode: 70 per part (67 once split). The same 202-character
// confirmation is 2 parts in GSM-7 and 4 parts in unicode, which costs more and is the kind of
// multi-part burst carriers are quickest to filter. So: swap the usual offenders for plain look-alikes
// before anything is stored or sent. Billing to the shop is per message, never per part.

const REPLACEMENTS: [RegExp, string][] = [
  [/[\u2013\u2014\u2212\u2012\u2015]/g, "-"], // en/em dashes, minus
  [/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, "'"], // curly single quotes, prime, acute
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'], // curly double quotes
  [/\u2026/g, "..."], // ellipsis
  [/[\u2022\u00B7\u2219]/g, "-"], // bullets
  [/[\u00A0\u2007\u202F\u2009\u200A\u2002\u2003]/g, " "], // odd spaces
  [/[\u200B\u200C\u200D\uFEFF]/g, ""], // zero-width
  [/\u00D7/g, "x"],
  [/\u2192/g, "->"],
];

// Letters with no GSM-7 form that are worth keeping as a plain look-alike.
const LOOKALIKE: Record<string, string> = { "\u2605": "*", "\u2606": "*", "\u0141": "L", "\u0142": "l", "\u0110": "D", "\u0111": "d", "\u0152": "OE", "\u0153": "oe" };

export function gsmSafe(s: string): string {
  let out = s;
  for (const [re, to] of REPLACEMENTS) out = out.replace(re, to);
  // Anything still outside GSM-7 would switch the whole text to unicode (70 characters a part):
  // accents come off (Zoë -> Zoe), a few letters map to look-alikes, emoji and symbols are dropped.
  let res = "";
  for (const ch of out) {
    if (isGsm(ch)) res += ch;
    else if (LOOKALIKE[ch]) res += LOOKALIKE[ch];
    else {
      const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (base && [...base].every(isGsm)) res += base;
    }
  }
  return res.replace(/ {2,}/g, " ");
}

const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€"; // each costs two characters

export function smsParts(s: string): { encoding: "GSM-7" | "UNICODE"; characters: number; parts: number } {
  let units = 0;
  let gsm = true;
  for (const ch of s) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (gsm) return { encoding: "GSM-7", characters: units, parts: units <= 160 ? 1 : Math.ceil(units / 153) };
  const n = [...s].reduce((a, ch) => a + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return { encoding: "UNICODE", characters: n, parts: n <= 70 ? 1 : Math.ceil(n / 67) };
}

const isGsm = (ch: string) => GSM_BASIC.includes(ch) || GSM_EXT.includes(ch);
const gsmLen = (s: string) => [...s].reduce((n, ch) => n + (GSM_EXT.includes(ch) ? 2 : 1), 0);

// ---- One part per text --------------------------------------------------------------------------
// Providers bill per part: 160 GSM-7 characters is one part, 161 is two. Every text is fitted to one
// part at send time: plain characters, long links swapped for a short one, optional bits dropped,
// and only then the words before the first link shortened. Links are never cut.
export const ONE_PART = 160;
export const LONG_LINK = 45; // links longer than this are shortened (a short link is ~42 characters)
const URL_RE = /https?:\/\/[^\s]*[^\s.,!?)]/g;
export const linksIn = (s: string) => [...new Set(s.match(URL_RE) || [])];

/** Shop name for the start of a text: the full name when it is short, otherwise whole words up to 22. */
export function smsName(name: string): string {
  const n = (name || "").trim().replace(/\s+/g, " ");
  if (n.length <= 22) return n;
  let out = "";
  for (const w of n.split(" ")) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > 22) break;
    out = next;
  }
  return out || n.slice(0, 22);
}

// Wording that can go when a text is over one part, in this order.
const OPTIONAL: [RegExp, string][] = [
  [/\s*\bRef [A-Z0-9]+-[A-Z0-9-]+\./g, ""],
  [/(Move or cancel|Book again|Manage|Change or cancel): /g, ""],
  [/Need to change it\? /g, ""],
];

/** Shorten an over-long text to one part without touching its links. Returns it unchanged if the
 *  links alone leave no room (a cut link is worse than a second part). */
export function trimToOnePart(text: string): string {
  let s = text.trim();
  const fits = (x: string) => gsmLen(x) <= ONE_PART;
  if (fits(s)) return s;
  for (const [re, to] of OPTIONAL) {
    s = s.replace(re, to).replace(/ {2,}/g, " ").trim();
    if (fits(s)) return s;
  }
  const at = s.search(/https?:\/\//);
  const head = at < 0 ? s : s.slice(0, at).trimEnd();
  const tail = at < 0 ? "" : s.slice(at);
  const budget = ONE_PART - gsmLen(tail) - (tail ? 1 : 0) - 3; // room for the words, "..." and a space
  if (budget < 12) return s;
  let h = head;
  while (gsmLen(h) > budget && /\s/.test(h)) h = h.replace(/\s*\S+$/, "");
  if (gsmLen(h) > budget) h = [...h].slice(0, budget).join("");
  h = h.replace(/[\s,;:.-]+$/, "");
  return tail ? `${h}... ${tail}` : `${h}...`;
}

/** The text exactly as it will be sent: plain characters, long links shortened, one part. */
export async function fitSms(body: string, shorten?: (url: string) => Promise<string>): Promise<string> {
  let s = gsmSafe(body).trim();
  // Links are only shortened when the text would otherwise run past one part.
  if (shorten && gsmLen(s) > ONE_PART) {
    for (const u of linksIn(s).filter((x) => x.length > LONG_LINK && !/\/s\/[A-Za-z0-9]{8}$/.test(x))) {
      const short = await shorten(u).catch(() => u);
      if (short && short.length < u.length) s = s.split(u).join(short);
    }
  }
  return trimToOnePart(s);
}

/** For previews: what a text will look like once long links are shortened (no database needed). */
export function previewSms(body: string): { text: string; characters: number; parts: number } {
  let s = gsmSafe(body).trim();
  for (const u of gsmLen(s) > ONE_PART ? linksIn(s).filter((x) => x.length > LONG_LINK) : []) {
    let origin = "";
    try { origin = new URL(u).origin; } catch { continue; }
    s = s.split(u).join(`${origin}/s/xxxxxxxx`);
  }
  s = trimToOnePart(s);
  const p = smsParts(s);
  return { text: s, characters: p.characters, parts: p.parts };
}
