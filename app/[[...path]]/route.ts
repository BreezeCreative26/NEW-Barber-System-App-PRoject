// Every request goes through the Hono app (API routes and the HTML shells alike). Next.js is the
// host: it gives us Vercel deploys, previews, cron and the Node runtime; Hono keeps the routing
// and the ported server logic unchanged.
import app, { type AppBindings } from "../../src/index";
import { getDb } from "../../src/db/client";
import { getStore } from "../../src/db/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function env(): AppBindings {
  return { DB: getDb(), MEDIA: getStore(), ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS, DEMO_ENABLED: process.env.DEMO_ENABLED };
}
const handle = (req: Request) => app.fetch(req, env());
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
export const HEAD = handle;
