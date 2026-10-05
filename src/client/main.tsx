// Owner / admin entry: the workspace and the platform admin. Customers never load this file —
// their screens live in shop.tsx.
import { createRoot } from "react-dom/client";
import "./fonts.css";
import { Workspace } from "./Workspace";
import { Admin } from "./Admin";
import { VerifyEmail } from "./VerifyEmail";
import { AppErrorBoundary, BUILD_ID, installErrorReporting, parseRoute, reportClientError } from "./boot";
export { reportClientError };

installErrorReporting();
const { area } = parseRoute();
// Owner and staff installs use the same server-enforced role/session boundaries.
// The safe worker caches static assets only; it cannot open a workspace offline.
if (area === "workspace" && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`/sw.js?b=${encodeURIComponent(BUILD_ID)}`, { scope: "/workspace", updateViaCache: "none" })
    .then(reg => reg.update()).catch(() => {});
}
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    {area === "admin" ? <Admin /> : area === "verify" ? <VerifyEmail /> : <Workspace />}
  </AppErrorBoundary>,
);
