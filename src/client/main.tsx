import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.css";
import { Workspace } from "./Workspace";
import { PublicBooking, ManageBooking } from "./PublicBooking";
import { ShopPage } from "./ShopPage";
import { CustomerArea } from "./CustomerArea";
import { OfferPage } from "./OfferPage";

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
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
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    {area === "book" && param ? (
      <PublicBooking slug={decodeURIComponent(param)} />
    ) : area === "manage" && param ? (
      <ManageBooking token={param} />
    ) : area === "offer" && param ? (
      <OfferPage token={param} />
    ) : area && area !== "workspace" && param === "me" ? (
      <CustomerArea slug={decodeURIComponent(area)} />
    ) : area && area !== "workspace" && !param ? (
      <ShopPage slug={decodeURIComponent(area)} />
    ) : (
      <Workspace />
    )}
  </AppErrorBoundary>,
);
