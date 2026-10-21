// Vercel build: migrate the database only on production deploys. Preview deploys share env vars
// with production, so migrating there would alter the live database from a branch.
import { spawnSync } from "node:child_process";
const run = (cmd) => {
  const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const env = process.env.VERCEL_ENV;
if (!env || env === "production") { run("npm run db:migrate"); run("node scripts/reset-live.mjs"); }
else console.log(`VERCEL_ENV=${env}: skipping db:migrate (production only)`);
run("npm run build");
