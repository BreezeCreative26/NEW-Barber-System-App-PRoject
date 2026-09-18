import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.css";
import { Workspace } from "./Workspace";
import { PublicBooking, ManageBooking } from "./PublicBooking";
import { ShopPage } from "./ShopPage";
import { CustomerArea } from "./CustomerArea";
import { OfferPage } from "./OfferPage";

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
window.addEventListener("error", (e) => reportClientError(e.error ?? e.message, "window"));
window.addEventListener("unhandledrejection", (e) => reportClientError(e.reason, "promise"));

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
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
        <h1>The workspace could not display this view</h1>
        <p>
          Reload to check your saved records. If a save was in progress, inspect its result before
          repeating it.
        </p>
        <a className="button primary" href={location.pathname}>
          Reload workspace
        </a>
      </main>
    ) : (
      this.props.children
    );
  }
}
const [, area, param] = location.pathname.split("/");
const APP_AREAS = new Set(["workspace", "signin", "signup", "forgot", "reset", ""]);
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    {area === "book" && param ? (
      <PublicBooking slug={decodeURIComponent(param)} />
    ) : area === "manage" && param ? (
      <ManageBooking token={param} />
    ) : area === "offer" && param ? (
      <OfferPage token={param} />
    ) : area && !APP_AREAS.has(area) && param === "me" ? (
      <CustomerArea slug={decodeURIComponent(area)} />
    ) : area && !APP_AREAS.has(area) && !param ? (
      <ShopPage slug={decodeURIComponent(area)} />
    ) : (
      <Workspace />
    )}
  </AppErrorBoundary>,
);
