// Alphanumeric SMS sender rules + suggestions (pure; shared by the field component and tests).
export const SENDER_MAX = 11;
const FILLER = new Set(["the", "a", "an", "and", "&", "of"]);

/** Same rule as the server's smsSenderFor: whole words, ≤11 chars, must contain a letter. */
export function suggestSenders(shopName: string): string[] {
  const clean = shopName.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  // Drop tokens that read like codes (hex ids, long digit runs) — never a good name on a lock screen.
  const all = clean.split(" ").filter(Boolean).filter((w) => !/^[0-9a-f]{6,}$/i.test(w) && !/^\d{4,}$/.test(w));
  const words = all.length > 1 && FILLER.has(all[0].toLowerCase()) ? all.slice(1) : all;
  const out: string[] = [];
  const push = (s: string) => { const v = s.trim(); if (v.length >= 3 && v.length <= SENDER_MAX && /[A-Za-z]/.test(v) && !out.includes(v)) out.push(v); };
  // 1. As many whole words as fit.
  let acc = "";
  for (const w of words) { const next = acc ? `${acc} ${w}` : w; if (next.length > SENDER_MAX) break; acc = next; }
  push(acc);
  // 2. Words without spaces (fits more: "NorthlineBarbers" → no, "FadeLab" → yes).
  push(words.join(""));
  // 3. First word only.
  if (words[0]) push(words[0].slice(0, SENDER_MAX));
  // 4. Initials + last word ("JK Cuts" style) when there are 3+ words.
  if (words.length >= 3) push(`${words.slice(0, -1).map((w) => w[0]).join("").toUpperCase()} ${words[words.length - 1]}`);
  // 5. First word + "Barbers"/last-word initial.
  if (words.length >= 2) push(`${words[0]} ${words[words.length - 1][0].toUpperCase()}`);
  return out.slice(0, 4);
}

export type SenderCheck = { ok: boolean; level: "good" | "warn" | "bad"; note: string };
/** Carrier rules + readability advice. */
export function checkSender(v: string): SenderCheck {
  const s = v.trim();
  if (!s) return { ok: false, level: "warn", note: "Empty — we'll use the suggested name until you pick one." };
  if (/[^A-Za-z0-9 ]/.test(s)) return { ok: false, level: "bad", note: "Letters, numbers and spaces only — no & . ' or emoji." };
  if (s.length > SENDER_MAX) return { ok: false, level: "bad", note: `Too long — networks allow ${SENDER_MAX} characters.` };
  if (!/[A-Za-z]/.test(s)) return { ok: false, level: "bad", note: "Needs at least one letter, or phones treat it as a number." };
  if (s.length < 3) return { ok: false, level: "bad", note: "Too short to be recognised — use at least 3 characters." };
  if (/^\d/.test(s)) return { ok: true, level: "warn", note: "Starting with a digit can look like a phone number. Consider leading with a letter." };
  if (s === s.toLowerCase()) return { ok: true, level: "warn", note: "All lower-case reads like a system message. Capitalise the first letter." };
  if (s === s.toUpperCase() && s.length > 4) return { ok: true, level: "warn", note: "ALL CAPS can read as shouting on a lock screen. Title Case is friendlier." };
  return { ok: true, level: "good", note: "Looks good — this is what customers will see at the top of every text." };
}

