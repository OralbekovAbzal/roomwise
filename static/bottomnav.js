/*
 * bottomnav.js — shared bottom tab bar (liquid-glass), injected on every page.
 * Replaces the old top hamburger nav. Icons are inline Lucide SVGs (bundled
 * locally — no CDN). Active tab is derived from the current file name.
 */
(function () {
  "use strict";

  // --- Real visible height (bulletproof vs. dvh quirks on Android WebView) ---
  // Drives `body { height: var(--app-h) }` so the flex "sandwich" gets a correct
  // bounded height → the middle <main> actually scrolls, and the bottom bar sits
  // above the keyboard (window.innerHeight shrinks on adjustResize).
  function setAppHeight() {
    var h = window.innerHeight;
    if (window.visualViewport && window.visualViewport.height) {
      h = Math.min(h, window.visualViewport.height);
    }
    if (h > 0) document.documentElement.style.setProperty("--app-h", h + "px");
  }
  setAppHeight();
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("orientationchange", setAppHeight);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", setAppHeight);

  var ICONS = {
    calc:
      '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/>' +
      '<line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/>' +
      '<path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>',
    history:
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    ai:
      '<path d="M9.94 14.06A2 2 0 0 0 8.5 12.6l-5.4-1.4a.5.5 0 0 1 0-.96l5.4-1.4A2 2 0 0 0 9.94 7.4l1.4-5.4a.5.5 0 0 1 .96 0l1.4 5.4a2 2 0 0 0 1.44 1.44l5.4 1.4a.5.5 0 0 1 0 .96l-5.4 1.4a2 2 0 0 0-1.44 1.44l-1.4 5.4a.5.5 0 0 1-.96 0z"/>' +
      '<path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    pricing:
      '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/>' +
      '<line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/>' +
      '<line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/>' +
      '<line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    key:
      '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/>' +
      '<path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  };

  var TABS = [
    { id: "calc",    href: "index.html",    label: "Расчёт",  files: ["", "index.html"] },
    { id: "history", href: "history.html",  label: "История", files: ["history.html"] },
    { id: "ai",      href: "parse.html",    label: "ИИ",      files: ["parse.html"] },
    { id: "pricing", href: "settings.html", label: "Цены",    files: ["settings.html"] },
    { id: "key",     href: "api-key.html",  label: "API",     files: ["api-key.html"] },
  ];

  function svg(name) {
    return '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || "") + "</svg>";
  }

  function currentFile() {
    var path = location.pathname.split("/").pop() || "";
    return path.split("?")[0];
  }

  function build() {
    if (document.querySelector(".rw-bottomnav")) return;
    var here = currentFile();
    var nav = document.createElement("nav");
    nav.className = "rw-bottomnav";
    nav.setAttribute("aria-label", "Основная навигация");

    TABS.forEach(function (t) {
      var a = document.createElement("a");
      a.className = "rw-tab" + (t.files.indexOf(here) !== -1 ? " rw-tab-active" : "");
      a.href = t.href;
      a.innerHTML = '<span class="rw-tab-ico">' + svg(t.id) + "</span><span>" + t.label + "</span>";
      nav.appendChild(a);
    });
    document.body.appendChild(nav);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
