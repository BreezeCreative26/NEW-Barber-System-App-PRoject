// No pinch or double-tap zoom in the installed app and on shop pages (text stays zoomable via the
// browser's own text-size setting). Page zoom is blocked without disabling it in the viewport tag:
// - CSS `touch-action: pan-x pan-y` on the page (design.css) stops pinch and double-tap zoom in
//   Chrome/Android and modern Safari without touching scrolling.
// - iOS Safari's own pinch gesture is cancelled here via its gesture events. These are not touch
//   or wheel events, so they never make the browser wait for JavaScript before it scrolls.
// There is deliberately NO touchmove listener: a non-passive touchmove on the document forces
// every swipe on every page to wait for the main thread, which is what made scrolling feel sticky.
(function () {
  if (!("ontouchstart" in window)) return;
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false });
  });
})();
