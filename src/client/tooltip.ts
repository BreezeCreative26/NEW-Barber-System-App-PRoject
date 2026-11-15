// Hover tips for anything with data-tip (desktop pointers only). The tip floats above the page, so
// it isn't clipped by calendar cards (which hide their overflow) and never shifts the layout.
export function installTooltips() {
  if (typeof window === "undefined" || !window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
  let tip: HTMLDivElement | null = null;
  let current: HTMLElement | null = null;
  const hide = () => { current = null; if (tip) tip.style.opacity = "0"; };
  document.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tip]");
    if (!el) return hide();
    if (el === current) return;
    current = el;
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "ollo-tip";
      tip.setAttribute("role", "tooltip");
      document.body.appendChild(tip);
    }
    tip.textContent = el.dataset.tip || "";
    const r = el.getBoundingClientRect();
    tip.style.opacity = "1";
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.min(window.innerWidth - w - 6, Math.max(6, r.left + r.width / 2 - w / 2));
    const top = r.top - h - 8 < 4 ? r.bottom + 8 : r.top - h - 8;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  });
  document.addEventListener("scroll", hide, true);
  document.addEventListener("pointerdown", hide, true);
}
