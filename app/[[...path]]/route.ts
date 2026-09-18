// Every request goes through the Hono app (API routes and the HTML shells alike). Next.js is the
// host: it gives us Vercel deploys, previews, cron and the Node runtime; Hono keeps the routing
// and the ported server logic unchanged.
import app, { type AppBindings } from "../../src/index";
import { getDb } from "../../src/db/client";
import { getStore } from "../../src/db/storage";
import { report, telemetryStatus } from "../../src/server/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Building the bindings must never take the whole site down. If DATABASE_URL is missing or the
// storage client cannot initialise, remember why and let /api/diag report it instead of every
// route dying with an empty 500 before Hono runs.
let bootError: string | null = null;
function env(): AppBindings {
  let DB: AppBindings["DB"] | undefined;
  let MEDIA: AppBindings["MEDIA"] | undefined;
  try {
    DB = getDb();
  } catch (e) {
    bootError = `db: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    MEDIA = getStore();
  } catch (e) {
    bootError = `${bootError ? bootError + "; " : ""}storage: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { DB: DB as AppBindings["DB"], MEDIA: MEDIA as AppBindings["MEDIA"], ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS, DEMO_ENABLED: process.env.DEMO_ENABLED };
}
const REQUIRED = ["DATABASE_URL", "SESSION_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
async function diag(req: Request) {
  const e = env();
  const missing = REQUIRED.filter((k) => !process.env[k]);
  const dbUrl = process.env.DATABASE_URL || "";
  let dbHost = "";
  try {
    dbHost = dbUrl ? new URL(dbUrl.replace(/^postgres(ql)?:/, "http:")).host : "";
  } catch {
    dbHost = "unparseable";
  }
  let dbPing: string = "skipped";
  if (e.DB && new URL(req.url).searchParams.get("ping") === "1") {
    try {
      const t0 = Date.now();
      await e.DB.prepare("SELECT 1 AS ok").first();
      dbPing = `ok ${Date.now() - t0}ms`;
    } catch (err) {
      dbPing = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return Response.json({
    node: process.version,
    region: process.env.VERCEL_REGION ?? null,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    env_missing: missing,
    db_host: dbHost,
    db_ping: dbPing,
    boot_error: bootError,
    telemetry: telemetryStatus(),
  });
}
const handle = async (req: Request) => {
  const path = new URL(req.url).pathname;
  if (path === "/api/diag") return diag(req);
  try {
    return await app.fetch(req, env());
  } catch (err) {
    // Last resort: a readable 500 instead of an empty one.
    void report({ message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, route: path, method: req.method, status: 500, source: "server", tags: { boot_error: bootError ?? "" } });
    return Response.json({ error: "server_error", message: err instanceof Error ? err.message : String(err), boot_error: bootError }, { status: 500 });
  }
};
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
export const HEAD = handle;
