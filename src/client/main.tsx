// Owner / admin entry: the workspace and the platform admin. Customers never load this file —
// their screens live in shop.tsx.
import { createRoot } from "react-dom/client";
import "./fonts.css";
import { Workspace } from "./Workspace";
import { Admin } from "./Admin";
import { VerifyEmail } from "./VerifyEmail";
import { AppErrorBoundary, installErrorReporting, parseRoute, reportClientError } from "./boot";
import { installToaster } from "./toaster";
import { installTooltips } from "./tooltip";
import { installPickers } from "./pickers";
export { reportClientError };

installErrorReporting();
installToaster();
installTooltips();
// Our own date / time pickers replace the browser's dated pop-ups everywhere (see pickers.ts).
installPickers();
const { area } = parseRoute();
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    {area === "admin" ? <Admin /> : area === "verify" ? <VerifyEmail /> : <Workspace />}
  </AppErrorBoundary>,
);
