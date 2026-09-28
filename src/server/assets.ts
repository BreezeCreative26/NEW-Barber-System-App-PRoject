// Client build → HTML shell. Vite writes public/static/manifest.json mapping each entry to its
// hashed JS/CSS files. The shells read it once per process, so every deploy's HTML points at that
// deploy's files: browsers and installed apps pick up a new build the moment the HTML is fetched,
// and the hashed files themselves can be cached forever.
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Chunk = { file: string; css?: string[]; imports?: string[]; isEntry?: boolean };
type Manifest = Record<string, Chunk>;

let manifest: Manifest | null = null;
let buildId = "";
function load(): Manifest {
  if (manifest) return manifest;
  try {
    manifest = JSON.parse(readFileSync(join(process.cwd(), "public", "static", "manifest.json"), "utf8")) as Manifest;
  } catch {
    manifest = {};
  }
  // Build identity = the hash baked into the entry file names (changes whenever any client code
  // changes). Falls back to the deploy's commit so the check still works before the first build.
  const files = Object.values(manifest).filter((m) => m.isEntry).map((m) => m.file).sort().join("|");
  buildId = files ? hash(files) : (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 12);
  return manifest;
}
function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
export function currentBuild(): string {
  load();
  return buildId;
}
// Tags for one entry: its CSS (plus imported chunks' CSS), preloads for the chunks it imports, and
// the module script. Falls back to the un-hashed legacy name when no manifest exists (local dev
// before `npm run build:client`).
export function entryTags(entry: "app" | "shop"): string {
  const m = load();
  const key = entry === "app" ? "src/client/main.tsx" : "src/client/shop.tsx";
  const chunk = m[key];
  if (!chunk) return `<script type="module" src="/static/app.js"></script>`;
  const seen = new Set<string>();
  const css: string[] = [];
  const preload: string[] = [];
  const walk = (c: Chunk | undefined) => {
    if (!c) return;
    for (const f of c.css || []) if (!seen.has(f)) { seen.add(f); css.push(f); }
    for (const imp of c.imports || []) {
      const dep = m[imp];
      if (dep && !seen.has(dep.file)) { seen.add(dep.file); preload.push(dep.file); walk(dep); }
    }
  };
  walk(chunk);
  return [
    ...css.map((f) => `<link rel="stylesheet" href="/static/${f}"/>`),
    ...preload.map((f) => `<link rel="modulepreload" href="/static/${f}"/>`),
    `<meta name="foliyo-build" content="${buildId}"/>`,
    `<script type="module" src="/static/${chunk.file}"></script>`,
  ].join("");
}
// Every file the customer app needs offline, for the service worker's pre-cache list.
export function shopAssetList(): string[] {
  const m = load();
  const out = new Set<string>();
  const walk = (c: Chunk | undefined) => {
    if (!c) return;
    out.add(`/static/${c.file}`);
    for (const f of c.css || []) out.add(`/static/${f}`);
    for (const imp of c.imports || []) walk(m[imp]);
  };
  walk(m["src/client/shop.tsx"]);
  return [...out];
}
