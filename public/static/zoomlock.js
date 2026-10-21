// No pinch or double-tap zoom in the installed app and on shop pages (text stays zoomable via the
// browser's own text-size setting). Page zoom is blocked without disabling it in the viewport tag.
(function () {
  if (!("ontouchstart" in window)) return;
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false });
  });
  document.addEventListener("touchmove", function (e) {
    if (e.touches && e.touches.length > 1 && e.scale !== 1) e.preventDefault();
  }, { passive: false });
})();
