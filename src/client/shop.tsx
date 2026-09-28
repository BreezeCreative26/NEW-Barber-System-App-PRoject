// Customer entry: the shop's app. Shop page, booking flow, account, waiting-list offers and the
// manage-a-visit page. Small on purpose — nothing from the owner workspace is imported here.
import { createRoot } from "react-dom/client";
import "./fonts.css";
import { PublicBooking, ManageBooking, presetFromLocation } from "./PublicBooking";
import { ShopPage } from "./ShopPage";
import { CustomerArea } from "./CustomerArea";
import { OfferPage } from "./OfferPage";
import { AppErrorBoundary, APP_AREAS, BUILD_ID, installErrorReporting, parseRoute } from "./boot";

installErrorReporting();
const { hostSlug, area, param, shopSlug } = parseRoute();

// The shop's app on the home screen. The worker is shared; its scope is the shop ("/" on the
// shop's own host, "/<slug>/" elsewhere). New builds: the worker is fetched on every open (browser
// rule for sw.js is max-age 0), installs the new asset list, takes over immediately and — if this
// page was rendered by an older build — reloads once so the customer is on the latest version.
if (shopSlug && "serviceWorker" in navigator) {
  const scope = hostSlug ? "/" : `/${decodeURIComponent(shopSlug)}/`;
  navigator.serviceWorker
    .register(`/sw.js?b=${encodeURIComponent(BUILD_ID)}`, { scope, updateViaCache: "none" })
    .then((reg) => {
      reg.update().catch(() => null);
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        // A new worker took over. If it carries a different build to the one that rendered this
        // page, the HTML we are showing references stale assets: reload once, quietly.
        if (reloading) return;
        const active = reg.active;
        if (!active) return;
        const workerBuild = new URL(active.scriptURL).searchParams.get("b") || "";
        if (workerBuild && BUILD_ID && workerBuild !== BUILD_ID && !document.querySelector('form[aria-busy="true"]')) {
          reloading = true;
          location.reload();
        }
      });
    })
    .catch(() => null);
  // Coming back to an installed app after a while: ask the server which build is live. If it has
  // moved on and nothing is mid-save, reload so the app matches the shop's dashboard exactly.
  let lastCheck = Date.now();
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || Date.now() - lastCheck < 30000) return;
    lastCheck = Date.now();
    try {
      const r = await fetch("/api/public/build", { cache: "no-store" });
      const j = (await r.json()) as { build: string };
      if (j.build && BUILD_ID && j.build !== BUILD_ID && !document.querySelector('form[aria-busy="true"], [role="dialog"]')) location.reload();
    } catch {
      /* offline: keep what we have */
    }
  });
}

const failCopy = { title: "This page could not be shown", body: "Reload to try again. Your booking is safe if it was confirmed.", cta: "Reload" };
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary {...failCopy}>
    {area === "book" && param ? (
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
      <main className="state-card">
        <h1>Page not found</h1>
        <a className="button primary" href="/">Home</a>
      </main>
    )}
  </AppErrorBoundary>,
);
