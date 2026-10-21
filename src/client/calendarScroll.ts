// Calmer scrolling inside the timetable. The board is long and every 15-minute row is short, so
// the browser's own wheel and flick speeds race through hours. Here the timetable scrolls at a
// gentler rate (wheel and finger), keeps a short, softer glide after a flick, and never hands the
// gesture on to the page, so dragging past the top or bottom no longer moves the whole screen.
// A booking being dragged (long-press) is left alone: `busy()` returns true while it is.

const WHEEL_RATE = 0.5; // share of each wheel/trackpad step actually scrolled
const TOUCH_RATE = 0.7; // share of the finger movement scrolled (vertical)
const FRICTION = 0.9; // per 16 ms frame; lower = shorter glide
const MAX_VELOCITY = 2.2; // px per ms after damping

export function calmScroll(el: HTMLElement, busy: () => boolean): () => void {
  let raf = 0;
  const stopGlide = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || busy()) return; // pinch-zoom gestures on trackpads arrive as ctrl+wheel
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
    let dy = e.deltaY * unit, dx = e.deltaX * unit;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    e.preventDefault();
    stopGlide();
    el.scrollTop += dy * WHEEL_RATE;
    el.scrollLeft += dx * WHEEL_RATE;
  };

  let start: { x: number; y: number; top: number; left: number } | null = null;
  let last = { y: 0, x: 0, t: 0 };
  let vel = { y: 0, x: 0 };
  let moving = false;
  const onTouchStart = (e: TouchEvent) => {
    stopGlide();
    if (e.touches.length !== 1) { start = null; return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, top: el.scrollTop, left: el.scrollLeft };
    last = { x: t.clientX, y: t.clientY, t: performance.now() };
    vel = { x: 0, y: 0 };
    moving = false;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!start || e.touches.length !== 1) return;
    if (busy()) { start = null; return; }
    const t = e.touches[0];
    const dy = t.clientY - start.y, dx = t.clientX - start.x;
    if (!moving && Math.abs(dy) < 4 && Math.abs(dx) < 4) return; // still a tap
    moving = true;
    e.preventDefault(); // we scroll; the page stays put
    el.scrollTop = start.top - dy * TOUCH_RATE;
    el.scrollLeft = start.left - dx;
    const now = performance.now(), dt = Math.max(1, now - last.t);
    vel = { y: 0.8 * ((last.y - t.clientY) / dt) * TOUCH_RATE + 0.2 * vel.y, x: 0.8 * ((last.x - t.clientX) / dt) + 0.2 * vel.x };
    last = { x: t.clientX, y: t.clientY, t: now };
  };
  const onTouchEnd = () => {
    if (!start) return;
    start = null;
    if (!moving || performance.now() - last.t > 80) return; // finger rested before lifting: no glide
    let vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, vel.y));
    let vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, vel.x));
    let prev = performance.now();
    const step = (now: number) => {
      const dt = Math.min(48, now - prev); prev = now;
      el.scrollTop += vy * dt; el.scrollLeft += vx * dt;
      const f = Math.pow(FRICTION, dt / 16);
      vy *= f; vx *= f;
      raf = Math.abs(vy) > 0.02 || Math.abs(vx) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    raf = requestAnimationFrame(step);
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onTouchEnd, { passive: true });
  return () => {
    stopGlide();
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchEnd);
  };
}
