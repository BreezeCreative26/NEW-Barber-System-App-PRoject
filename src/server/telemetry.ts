// Error reporting without a vendor SDK. When SENTRY_DSN is set, unexpected server errors are
// posted to Sentry's envelope endpoint with a plain fetch (works on Node and Workers, adds no
// dependency). Without a DSN it logs to stderr only. Payloads carry the route, method, status,
// commit and a message — never request bodies, cookies, sessions or customer contact details.
//
// Client-side errors are accepted at POST /api/telemetry/error (rate-limited, tiny schema) and
// forwarded the same way, so a blank screen on a shop's phone reaches someone.

type Level = "error" | "warning";
type Report = { message: string; stack?: string; route?: string; method?: string; status?: number; level?: Level; tags?: Record<string, string>; source: "server" | "client" };

function parseDsn(dsn: string) {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.username || !projectId) return null;
    return { publicKey: u.username, host: u.host, projectId, protocol: u.protocol };
  } catch {
    return null;
  }
}
const commit = () => (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || "dev";
const environment = () => process.env.VERCEL_ENV ?? (process.env.NODE_ENV === "production" ? "production" : "development");

export function telemetryStatus() {
  const dsn = process.env.SENTRY_DSN || "";
  return { provider: dsn && parseDsn(dsn) ? "sentry" : "log", environment: environment(), commit: commit() };
}

// Fire-and-forget. Never throws, never awaited by request handlers longer than a tick.
export function report(r: Report): Promise<void> {
  const line = `[${r.source}] ${r.method ?? ""} ${r.route ?? ""} ${r.status ?? ""} ${r.message}`.replace(/\s+/g, " ").trim();
  console.error(line, r.stack ? `\n${r.stack.split("\n").slice(0, 6).join("\n")}` : "");
  const dsn = process.env.SENTRY_DSN || "";
  const parsed = dsn ? parseDsn(dsn) : null;
  if (!parsed) return Promise.resolve();
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const frames = (r.stack ?? "")
    .split("\n")
    .slice(1, 20)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ function: l.replace(/^at\s+/, "").slice(0, 200) }))
    .reverse();
  const event = {
    event_id: eventId,
    timestamp: now,
    platform: r.source === "client" ? "javascript" : "node",
    level: r.level ?? "error",
    environment: environment(),
    release: commit(),
    logger: r.source,
    transaction: r.route,
    tags: { source: r.source, method: r.method ?? "", status: String(r.status ?? ""), ...(r.tags ?? {}) },
    exception: { values: [{ type: "Error", value: r.message.slice(0, 500), ...(frames.length ? { stacktrace: { frames } } : {}) }] },
  };
  const envelope = `${JSON.stringify({ event_id: eventId, sent_at: now, dsn })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
  const url = `${parsed.protocol}//${parsed.host}/api/${parsed.projectId}/envelope/`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=ollo/1.0` },
    body: envelope,
    signal: ctl.signal,
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => clearTimeout(t));
}

// Convenience for Hono error handlers: report an unexpected error with route context.
export function reportRequestError(err: unknown, c: { req: { method: string; path: string } }, status = 500) {
  const e = err instanceof Error ? err : new Error(String(err));
  void report({ message: e.message, stack: e.stack, route: c.req.path, method: c.req.method, status, source: "server" });
}
