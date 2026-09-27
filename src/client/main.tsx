import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.css";
import { Workspace } from "./Workspace";
import { Admin } from "./Admin";
import { PublicBooking, ManageBooking, presetFromLocation } from "./PublicBooking";
import { ShopPage } from "./ShopPage";
import { CustomerArea } from "./CustomerArea";
import { OfferPage } from "./OfferPage";
import { VerifyEmail } from "./VerifyEmail";

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
const APP_AREAS = new Set(["workspace", "signin", "signup", "forgot", "reset", "verify", "admin", ""]);
// On a shop's own host (<slug>.foliyo.co.uk) the server tags the page with the slug and the short
// paths apply: "/" = shop page, "/book" = booking, "/me" = account. Elsewhere the slug is in the path.
const hostSlug = document.querySelector<HTMLMetaElement>('meta[name="foliyo-shop"]')?.content || "";
const segs = location.pathname.split("/");
let [, area, param] = segs;
if (hostSlug) {
  if (area === "") { area = hostSlug; param = ""; }
  else if (area === "book" && !param) { param = hostSlug; }
  else if (area === "me" && !param) { area = hostSlug; param = "me"; }
}
// Shop surfaces register the per-shop service worker so "Add to Home Screen" gives the customer the
// shop's app (manifest is per shop; the worker is shared, scoped to the shop: "/" on its host).
const shopSlugForWorker = area === "book" && param ? param : area && !APP_AREAS.has(area) ? area : "";
if (shopSlugForWorker && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: hostSlug ? "/" : `/${decodeURIComponent(shopSlugForWorker)}/` }).catch(() => null);
}
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    {area === "admin" ? (
      <Admin />
    ) : area === "verify" ? (
      <VerifyEmail />
    ) : area === "book" && param ? (
      <PublicBooking slug={decodeURIComponent(param)} preset={presetFromLocation()} />
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
