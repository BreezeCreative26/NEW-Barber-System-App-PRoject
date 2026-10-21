// One-off live-trial reset. Runs only when RESET_LIVE_TRIAL=WIPE-ALL-SHOPS and only once
// (a marker row in platform_kv stops repeats). Keeps plans, features, platform admins and migrations.
import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" }); config();
if (process.env.RESET_LIVE_TRIAL !== "WIPE-ALL-SHOPS") process.exit(0);
const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const KEY = `live_trial_reset_${process.env.RESET_LIVE_TRIAL_ID || "2026_10_21"}`;
if ((await sql`select 1 from platform_kv where key=${KEY}`).length) { console.log("reset already done, skipping"); await sql.end(); process.exit(0); }
const KEEP = new Set(["ollo_migrations", "plans", "features", "platform_admins", "platform_kv", "app_users"]);
await sql.begin(async (t) => {
  await t.unsafe("TRUNCATE shops CASCADE");
  const rows = await t`select tablename from pg_tables where schemaname='public'`;
  const rest = rows.map((r) => r.tablename).filter((n) => !KEEP.has(n) && n !== "shops");
  if (rest.length) await t.unsafe(`TRUNCATE ${rest.map((n) => `"${n}"`).join(", ")} CASCADE`);
  await t`delete from app_users where id not in (select user_id from platform_admins)`;
  await t`insert into platform_kv (key,value,updated_at) values (${KEY},'done',${Date.now()})`;
});
const left = await sql`select (select count(*) from shops) shops, (select count(*) from app_users) users, (select count(*) from plans) plans`;
console.log("live trial reset complete", JSON.stringify(left[0]));
await sql.end();
