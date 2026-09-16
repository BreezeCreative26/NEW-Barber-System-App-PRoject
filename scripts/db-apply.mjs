// Apply src/db/schema.sql to the database in DIRECT_URL (session pooler / direct connection).
// Idempotent guard: refuses to run against a non-empty schema unless --force (drops everything).
import { readFileSync } from "node:fs";
import postgres from "postgres";
import "dotenv/config";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) throw new Error("DIRECT_URL / DATABASE_URL not set");
const force = process.argv.includes("--force");
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const [{ n }] = await sql`select count(*)::int as n from information_schema.tables where table_schema='public'`;
if (n > 0 && !force) {
  console.log(`public schema already has ${n} tables; pass --force to drop and recreate.`);
  await sql.end();
  process.exit(0);
}
if (n > 0) {
  console.log("dropping public schema…");
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres; GRANT ALL ON SCHEMA public TO public;");
}
await sql.unsafe(readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
const [{ t }] = await sql`select count(*)::int as t from information_schema.tables where table_schema='public'`;
console.log(`schema applied: ${t} tables`);
await sql.end();
