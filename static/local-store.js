/*
 * local-store.js — on-device config storage (replaces server-side prices.json).
 * Default config is bundled here; admin edits persist to localStorage.
 * Exposes: window.LocalStore.
 */
(function () {
  "use strict";

  const PRICING_KEY = "roomwise_pricing";
  const GEMINI_KEY = "roomwise_gemini_key";

  // Canonical default config for the app (copy of prices.json).
  const DEFAULT_CONFIG = {
    constants: { meal_price: 7000 },
    periods: [
      { id: "p1", start: "06-15", end: "06-21" },
      { id: "p2", start: "06-22", end: "07-03" },
      { id: "p3", start: "07-04", end: "08-09" },
      { id: "p4", start: "08-10", end: "08-16" },
      { id: "p5", start: "08-17", end: "08-25" },
    ],
    categories: [
      { id: "econom", label: "Эконом", room_sizes: [2, 3, 4], allow_extra_beds: false, disabled_discount: 2000 },
      { id: "standard", label: "Стандарт", room_sizes: [2, 3, 4, 5], allow_extra_beds: false, disabled_discount: 3000 },
      { id: "comfort", label: "Комфорт", room_sizes: [2, 3], allow_extra_beds: true, disabled_discount: 3000 },
    ],
    prices: {
      econom: {
        adult: { p1: 15000, p2: 15000, p3: 16000, p4: 15000, p5: 15000 },
        child: { p1: 13000, p2: 13000, p3: 14000, p4: 13000, p5: 13000 },
      },
      standard: {
        adult: { p1: 15000, p2: 17000, p3: 21000, p4: 17000, p5: 15000 },
        child: { p1: 14000, p2: 15000, p3: 17000, p4: 15000, p5: 14000 },
      },
      comfort: {
        adult: { p1: 16000, p2: 19000, p3: 24000, p4: 19000, p5: 16000 },
        child: { p1: 14000, p2: 16000, p3: 19000, p4: 16000, p5: 14000 },
        extra_bed: { p1: 15000, p2: 15000, p3: 17000, p4: 15000, p5: 15000 },
      },
    },
  };

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function getConfig() {
    try {
      const raw = localStorage.getItem(PRICING_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to default */ }
    return clone(DEFAULT_CONFIG);
  }

  // Validate by constructing the engine (throws PricingError) then persist.
  function saveConfig(obj) {
    // Will throw window.PricingError on invalid structure.
    new window.PricingEngine(obj);
    localStorage.setItem(PRICING_KEY, JSON.stringify(obj));
    return true;
  }

  function resetConfig() {
    localStorage.removeItem(PRICING_KEY);
  }

  function getGeminiKey() {
    try {
      return (localStorage.getItem(GEMINI_KEY) || "").trim();
    } catch (e) { return ""; }
  }

  function setGeminiKey(value) {
    const v = (typeof value === "string" ? value : "").trim();
    if (v) localStorage.setItem(GEMINI_KEY, v);
    else localStorage.removeItem(GEMINI_KEY);
  }

  window.LocalStore = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    getConfig: getConfig,
    saveConfig: saveConfig,
    resetConfig: resetConfig,
    getGeminiKey: getGeminiKey,
    setGeminiKey: setGeminiKey,
  };
})();
