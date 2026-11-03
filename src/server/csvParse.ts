// CSV reading rules shared by the server and the browser. No imports on purpose: the browser uses the
// same parser and the same "is the first row a heading?" test to cut big files into parts that the
// server reads exactly as it would have read the whole file.

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

const EMAIL_TEST = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
export const HEADER_WORDS = /^(name|full name|first name|last name|surname|forename|contact|owner|business|business name|company|shop|salon|trading name|phone|mobile|tel|telephone|cell|email|e-mail|email address|address|postcode|town|city|website|notes?)$/i;

/** True when the first row looks like column headings rather than a person. */
export function isHeaderRow(first: string[]): boolean {
  return first.length > 0 && first.filter((c) => HEADER_WORDS.test(c.trim())).length >= Math.min(2, first.length) && !first.some((c) => EMAIL_TEST.test(c) || /\d{7,}/.test(c.replace(/\D/g, "")));
}
