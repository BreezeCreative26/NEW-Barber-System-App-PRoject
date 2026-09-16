// Apply src/db/migrations/*.sql in order against DIRECT_URL, tracking applied files in ollo_migrations.
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import "dotenv/config";
const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) throw new Error("DIRECT_URL / DATABASE_URL not set");
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
await sql.unsafe("CREATE TABLE IF NOT EXISTS ollo_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
const done = new Set((await sql`select name from ollo_migrations`).map((r) => r.name));
const dir = new URL("../src/db/migrations/", import.meta.url);
for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
  if (done.has(f)) continue;
  process.stdout.write(`applying ${f}… `);
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(new URL(f, dir), "utf8"));
    await tx`insert into ollo_migrations(name) values (${f})`;
  });
  console.log("ok");
}
await sql.end();
console.log("migrations up to date");
