// Shared boot for both entries (customer app and owner workspace): error reporting, the error
// boundary, and route parsing. Kept free of screen imports so the customer bundle stays small.
import { Component, useEffect, type ReactNode } from "react";

// Browser errors reach the same sink as server errors (see src/server/telemetry.ts). Dedupe by
// message so a render loop cannot flood the endpoint; the server also rate-limits per client.
const reported = new Set<string>();
export function reportClientError(err: unknown, where = "") {
  const e = err instanceof Error ? err : new Error(String(err));
  const key = `${where}:${e.message}`;
  if (reported.has(key) || reported.size > 20) return;
  reported.add(key);
  try {
    void fetch("/api/telemetry/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ message: e.message, stack: (e.stack ?? "").slice(0, 4000), route: `${location.pathname}${where ? ` (${where})` : ""}`, ua: navigator.userAgent.slice(0, 200), screen: `${innerWidth}x${innerHeight}` }),
    });
  } catch {
    /* offline or blocked: nothing to do */
  }
}
export function installErrorReporting() {
  window.addEventListener("error", (e) => reportClientError(e.error ?? e.message, "window"));
  window.addEventListener("unhandledrejection", (e) => reportClientError(e.reason, "promise"));
}

export class AppErrorBoundary extends Component<{ children: ReactNode; title?: string; body?: string; cta?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    reportClientError(error, "boundary");
  }
  render() {
    return this.state.failed ? (
      <main className="state-card">
        <h1>{this.props.title || "The workspace could not display this view"}</h1>
        <p>{this.props.body || "Reload to check your saved records. If a save was in progress, inspect its result before repeating it."}</p>
        <a className="button primary" href={location.pathname}>
          {this.props.cta || "Reload workspace"}
        </a>
      </main>
    ) : (
      this.props.children
    );
  }
}

export const APP_AREAS = new Set(["workspace", "signin", "signup", "forgot", "reset", "verify", "admin", ""]);
// On a shop's own host (<slug>.foliyo.co.uk) the server tags the page with the slug and the short
// paths apply: "/" = shop page, "/book" = booking, "/me" = account. Elsewhere the slug is in the path.
export function parseRoute() {
  const hostSlug = document.querySelector<HTMLMetaElement>('meta[name="foliyo-shop"]')?.content || "";
  const segs = location.pathname.split("/");
  let [, area, param] = segs;
  if (hostSlug) {
    if (area === "") { area = hostSlug; param = ""; }
    else if (area === "book" && !param) { param = hostSlug; }
    else if (area === "me" && !param) { area = hostSlug; param = "me"; }
  }
  const shopSlug = area === "book" && param ? param : area && !APP_AREAS.has(area) ? area : "";
  return { hostSlug, area, param, shopSlug };
}

// Build identity, stamped into the shell by the server. The service worker and the update check
// compare it against the deployed build so a phone never keeps running yesterday's app.
export const BUILD_ID = document.querySelector<HTMLMetaElement>('meta[name="foliyo-build"]')?.content || "";

// While the first data request is in flight, keep showing the shop's mark the server painted in
// the shell (same markup, so there is no flash between the HTML boot screen and React's).
export function Boot({ label = "Opening…" }: { label?: string }) {
  const html = bootMarkup();
  if (html) return <div dangerouslySetInnerHTML={{ __html: html }} role="status" aria-label={label} />;
  return <p className="boot-message" role="status">{label}</p>;
}
let captured: string | null = null;
function bootMarkup(): string {
  if (captured !== null) return captured;
  const el = typeof document !== "undefined" ? document.querySelector(".boot-shop") : null;
  captured = el ? el.outerHTML : "";
  return captured;
}
// Capture the server's boot screen before React replaces #root.
if (typeof document !== "undefined") bootMarkup();

// Live data for the customer's app: re-read when the app comes back to the foreground and every
// `every` ms while it is visible, so a visit the shop moves or a booking made on another device
// shows up without a manual refresh — the same feel as the owner's dashboard. Skipped while a
// form is saving or a dialog is open so nothing changes under the customer's thumb.
export function useLive(refresh: () => void | Promise<unknown>, deps: unknown[], every = 15000) {
  useEffect(() => {
    let last = Date.now();
    const quiet = () => !document.querySelector('form[aria-busy="true"], [role="dialog"], [aria-busy="true"] input:focus');
    const tick = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || !quiet()) return;
      last = Date.now();
      void refresh();
    };
    const onVisible = () => { if (document.visibilityState === "visible" && Date.now() - last > 2000) tick(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", tick);
    const timer = window.setInterval(() => { if (Date.now() - last >= every - 250) tick(); }, Math.min(every, 5000));
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", tick);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
