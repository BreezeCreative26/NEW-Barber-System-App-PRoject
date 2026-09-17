// Scans user-facing source for engineering / roadmap language that must never reach a barber.
// Checks JSX text and string literals in src/client and the server-rendered strings in
// src/server/public.ts, presence.ts, customers.ts, waitlist.ts. Fails with a list of offenders.
// Add legitimate uses to ALLOW (exact substring of the offending line).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BANNED = [
  /\bin this build\b/i,
  /\bnot yet\b/i,
  /\bcoming soon\b/i,
  /["'>]\s*placeholder\b/i, // the word shown to a user, not the HTML attribute
  /\bTODO\b/,
  /\bharness\b/i,
  /\bfixture\b/i,
  /\bsandbox\b/i,
  /\bneeds provider\b/i,
  /\bPlanned next\b/,
  /\bLater\s*·/,
  /\bdocs\/[A-Za-z-]+\.md\b/,
  /\bRead the plan\b/,
  /YOUR SHOP \//,
  /\bManage your shop\. Changes are saved\b/,
  /[£$€](?![{`])(?=\d|\)|\s*\})/, // hard-coded currency symbols next to numbers or in "(£)" labels
];
const ALLOW = [
  "sandbox_", // API path aliases / identifiers
  "/api/sandbox", // legacy alias kept one release
  "kind: \"sandbox\"",
  "mode: \"sandbox\"",
  "data-testid",
  "fixture: true", // test hook param in client (demo shop)
  "fixture:", // ditto
  "sandbox.spec",
  "import ",
  "// ",
  "/* ",
  " * ",
  "console.",
  "aria-hidden",
  "currencySymbol",
  "money(",
  "placeholder=", // HTML attribute
  "placeholder:", // form field config
  "sandbox-owner:", // legacy audit actor prefix, rewritten for display
  "from \"./sandbox\"",
  "app.route(",
  "Content-Security-Policy",
  "const esc =",
];
const roots = ["src/client", "src/server/public.ts", "src/server/presence.ts", "src/server/customers.ts", "src/server/waitlist.ts", "src/index.tsx"];
const files = [];
for (const r of roots) {
  if (statSync(r).isDirectory()) { for (const f of readdirSync(r)) if (/\.tsx?$/.test(f) && statSync(join(r, f)).isFile()) files.push(join(r, f)); }
  else files.push(r);
}
const hits = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (ALLOW.some((a) => line.includes(a))) return;
    // Only inspect lines that carry user-facing text: JSX text, string literals, template literals.
    if (!/["'`>]/.test(line)) return;
    for (const re of BANNED) if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
}
if (hits.length) {
  console.error(`ux-lint: ${hits.length} user-facing string(s) break docs/UX-STANDARD.md §3:\n` + hits.join("\n"));
  process.exit(1);
}
console.log(`ux-lint: ${files.length} files clean`);
