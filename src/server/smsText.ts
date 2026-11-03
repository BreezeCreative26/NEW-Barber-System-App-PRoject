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

export function gsmSafe(s: string): string {
  let out = s;
  for (const [re, to] of REPLACEMENTS) out = out.replace(re, to);
  return out;
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
