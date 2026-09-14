#!/usr/bin/env node
// Design-system guardrails. Fails the gate when the codebase drifts from docs/DESIGN.md.
//  1. design.css: raw colours are only allowed inside :root (everything else must use tokens).
//  2. src/: no emoji in UI source; icons come from <Icon> (lucide) only.
//  3. src/client: no new stylesheet files outside style.css/design.css/fonts.css.
//  4. style.css must not grow (legacy sheet is frozen; new rules go to design.css with tokens).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const failures = [];

// 1. token-only design.css
{
  const css = readFileSync(join(root, "public/static/design.css"), "utf8");
  const rootStart = css.indexOf(":root {");
  const rootEnd = css.indexOf("\n}", rootStart);
  const body = css.slice(0, rootStart) + css.slice(rootEnd);
  const lines = body.split("\n");
  lines.forEach((line, i) => {
    if (/^\s*\/[/*]/.test(line)) return;
    if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(line)) {
      // allow translucent white/brand overlays only via rgba on the rail/tabbar (documented exceptions)
      if (/rgba\((255, 255, 255|105, 133, 232|74, 95, 217|24, 27, 42),/.test(line)) return;
      failures.push(`design.css:${i + 1}: raw colour outside :root -> use a token: ${line.trim()}`);
    }
  });
}

// 2. no emoji in src
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]/u;
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(f)) out.push(p);
  }
  return out;
}
for (const file of walk(join(root, "src"))) {
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    if (emoji.test(line)) failures.push(`${file.replace(root, "")}:${i + 1}: emoji in source; use <Icon name=...> instead`);
  });
}

// 3. stylesheet inventory
const allowed = new Set(["style.css", "design.css"]);
for (const f of readdirSync(join(root, "public/static"))) {
  if (f.endsWith(".css") && !allowed.has(f)) failures.push(`public/static/${f}: unexpected stylesheet; add rules to design.css`);
}
for (const f of readdirSync(join(root, "src/client"))) {
  if (f.endsWith(".css") && f !== "fonts.css") failures.push(`src/client/${f}: unexpected stylesheet; add rules to design.css`);
}

// 4. legacy sheet frozen (allow shrinking)
{
  const legacy = readFileSync(join(root, "public/static/style.css"), "utf8").split("\n").length;
  const cap = Number(readFileSync(join(root, "tests/design-legacy-cap.txt"), "utf8").trim());
  if (legacy > cap) failures.push(`public/static/style.css grew to ${legacy} lines (cap ${cap}). New styling belongs in design.css using tokens; lower the cap in tests/design-legacy-cap.txt only when removing legacy rules.`);
}

if (failures.length) {
  console.error("Design guardrails FAILED:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("PASS: design guardrails (tokens-only design.css, no emoji, stylesheet inventory, legacy sheet frozen).");
