// Owner / admin entry: the workspace and the platform admin. Customers never load this file —
// their screens live in shop.tsx.
import { createRoot } from "react-dom/client";
import "./fonts.css";
import { Workspace } from "./Workspace";
import { Admin } from "./Admin";
import { VerifyEmail } from "./VerifyEmail";
import { AppErrorBoundary, installErrorReporting, parseRoute, reportClientError } from "./boot";
export { reportClientError };

installErrorReporting();
// Desktop browsers only open a date field's calendar from its small icon; phones open it on any tap.
// Make a click anywhere on a date/time field open the picker on desktop too (the timetable's date
// chip is a hidden date field laid over the label, so without this a mouse click did nothing).
const PICKER_TYPES = new Set(["date", "time", "month", "week", "datetime-local"]);
const finePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)");
document.addEventListener("click", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !PICKER_TYPES.has(el.type)) return;
  if (el.disabled || el.readOnly || !finePointer?.matches) return;
  try {
    el.showPicker?.();
  } catch {
    // Not allowed here (e.g. already open, or no user gesture): the browser's own behaviour stands.
  }
});
const { area } = parseRoute();
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    {area === "admin" ? <Admin /> : area === "verify" ? <VerifyEmail /> : <Workspace />}
  </AppErrorBoundary>,
);
