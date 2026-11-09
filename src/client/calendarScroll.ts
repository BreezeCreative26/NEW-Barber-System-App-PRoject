// Timetable scrolling.
//
// Touch (phones/tablets): left entirely to the browser. Native scrolling runs off the main thread,
// so it keeps the phone's own momentum and never stutters while React is busy. The timetable's
// `overscroll-behavior: none` stops a swipe past the top or bottom from moving the whole screen.
//
// Wheel / trackpad (desktop): the board is long and every 15-minute row is short, so the browser's
// own wheel speed races through hours; here each wheel step scrolls at a gentler rate.
// A booking being dragged is left alone: `busy()` returns true while it is.

const WHEEL_RATE = 0.5; // share of each wheel/trackpad step actually scrolled

export function calmScroll(el: HTMLElement, busy: () => boolean): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || busy()) return; // pinch-zoom gestures on trackpads arrive as ctrl+wheel
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
    let dy = e.deltaY * unit, dx = e.deltaX * unit;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    e.preventDefault();
    el.scrollTop += dy * WHEEL_RATE;
    el.scrollLeft += dx * WHEEL_RATE;
  };
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => el.removeEventListener("wheel", onWheel);
}
