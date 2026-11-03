// Big CSVs cannot go to the server in one request: Vercel rejects bodies over ~4.5 MB before the app
// runs, and a request that looks up thousands of people one by one would also hit the 30 s function
// limit. So the browser reads the file with the same parser the server uses, cuts it into parts of
// whole rows, and sends the parts one after another. Every part repeats the heading row (when the
// file has one) and is written back out as plain comma-separated text, so the server reads each part
// exactly as it would have read that slice of the original file.
import { isHeaderRow, parseCsv } from "../server/csvParse";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PART_ROWS = 250; // the server checks each person against the database one by one
export const PART_CHARS = 1_000_000; // far below the 4.5 MB platform limit even if every character is multi-byte

export type Part = { text: string; rowsBefore: number };
export type Plan = { parts: Part[]; hasHeader: boolean; rows: number };

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const line = (cells: string[]) => cells.map(cell).join(",");

export function planParts(text: string, maxRows = PART_ROWS, maxChars = PART_CHARS): Plan {
  const table = parseCsv(text);
  const hasHeader = table.length > 0 && isHeaderRow(table[0]);
  const header = hasHeader ? line(table[0]) : "";
  const body = hasHeader ? table.slice(1) : table;
  const parts: Part[] = [];
  let cur: string[] = [];
  let size = 0;
  let before = 0;
  let used = 0;
  const flush = () => {
    if (!cur.length) return;
    parts.push({ text: (header ? header + "\n" : "") + cur.join("\n"), rowsBefore: before });
    before = used;
    cur = [];
    size = 0;
  };
  for (const row of body) {
    const l = line(row);
    if (cur.length >= maxRows || (cur.length && size + l.length > maxChars)) flush();
    cur.push(l);
    size += l.length + 1;
    used++;
  }
  flush();
  // Nothing but a heading (or an empty file): still send one part so the server can say what it found.
  if (!parts.length) parts.push({ text: header, rowsBefore: 0 });
  return { parts, hasHeader, rows: body.length };
}

/** Send each part in turn. Stops at the first failure and reports how many parts went through. */
export async function sendParts<T>(
  plan: Plan,
  send: (part: Part, index: number) => Promise<T>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ results: T[]; failed: Error | null }> {
  const results: T[] = [];
  onProgress?.(0, plan.parts.length);
  for (let i = 0; i < plan.parts.length; i++) {
    try {
      results.push(await send(plan.parts[i], i));
    } catch (e) {
      return { results, failed: e instanceof Error ? e : new Error("Upload failed") };
    }
    onProgress?.(i + 1, plan.parts.length);
  }
  return { results, failed: null };
}
