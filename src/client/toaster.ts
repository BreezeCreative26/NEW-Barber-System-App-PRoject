// Errors and "Saved" confirmations on the staff side show as pop-ups in the bottom-right corner
// (bottom of the screen on phones) instead of pushing the page down at the top of a panel.
// Every screen already renders them as .workspace-error / .workspace-success; this marks those
// elements as toasts and stacks them, so no screen needs its own toast code. Buttons inside a
// message (Retry, Undo, Discard edits…) keep working because the real element is shown.
// Click a message to dismiss it; errors also tidy themselves away after a while.
const SCOPE = ":is(.workspace, .modal, .wed, .ollo-admin-shell, .ask-dialog)";
const SEL = [
  `${SCOPE} :is(p, div).workspace-error:not([data-inline]):not([data-keep])`,
  `${SCOPE} :is(p, div).workspace-success:not([data-keep]):not([data-inline])`,
].join(",");
const ERROR_MS = 9000;
const GAP = 10;
const seen = new WeakMap<HTMLElement, { text: string; timer?: number }>();

function textOf(el: HTMLElement) {
  return (el.textContent || "").trim();
}
function hide(el: HTMLElement) {
  el.dataset.toastHidden = textOf(el);
}
function scan() {
  const els = [...document.querySelectorAll<HTMLElement>(SEL)];
  let bottom = 0;
  for (const el of els) {
    if (!el.hasAttribute("data-toast")) el.setAttribute("data-toast", el.classList.contains("workspace-error") ? "error" : "ok");
    const text = textOf(el);
    // New wording in the same message box (e.g. a second failed save) shows it again.
    if (el.dataset.toastHidden !== undefined && el.dataset.toastHidden !== text) delete el.dataset.toastHidden;
    const prev = seen.get(el);
    if (!prev || prev.text !== text) {
      if (prev?.timer) clearTimeout(prev.timer);
      const entry: { text: string; timer?: number } = { text };
      if (el.dataset.toast === "error" && !el.querySelector("button, a")) entry.timer = window.setTimeout(() => hide(el), ERROR_MS);
      seen.set(el, entry);
    }
    const shown = el.dataset.toastHidden === undefined && el.getClientRects().length > 0 && text.length > 0;
    if (!shown) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 4 || getComputedStyle(el).visibility === "hidden") continue;
    el.style.setProperty("--toast-stack", `${bottom}px`);
    bottom += r.height + GAP;
  }
}
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    scan();
  });
}
export function installToaster() {
  if (typeof document === "undefined" || (window as unknown as { __toaster?: boolean }).__toaster) return;
  (window as unknown as { __toaster?: boolean }).__toaster = true;
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "open", "hidden"] });
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const toast = t?.closest<HTMLElement>("[data-toast]");
    if (!toast || t!.closest("button, a, input, select, textarea, label")) return;
    hide(toast);
    schedule();
  });
  // Fading "Saved." messages finish their animation without a DOM change; restack afterwards.
  document.addEventListener("animationend", schedule, true);
  window.addEventListener("resize", schedule);
  schedule();
}
