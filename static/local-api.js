/*
 * local-api.js — intercepts fetch("/api/*") and serves it on-device, so the app
 * needs no Python server. Response shapes match the former FastAPI backend 1:1,
 * so app.js / parse.js / admin.js / api-key.js work unchanged.
 * Must be loaded BEFORE those scripts (and after pricing-engine/local-store/local-parse).
 */
(function () {
  "use strict";

  // Keep the real fetch for non-API calls and for the Gemini request.
  const origFetch = window.fetch.bind(window);
  window.__origFetch = origFetch;

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function engineFromStore() {
    return new window.PricingEngine(window.LocalStore.getConfig());
  }

  function parseBody(init) {
    if (!init || init.body == null) return {};
    try {
      return typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    } catch (e) {
      return {};
    }
  }

  async function handle(pathname, method, init) {
    // ----- health -----
    if (pathname === "/api/health") return json({ status: "ok" });

    // ----- categories -----
    if (pathname === "/api/categories") {
      const engine = engineFromStore();
      return json({ categories: engine.categoriesMeta() });
    }

    // ----- calculate -----
    if (pathname === "/api/calc" && method === "POST") {
      const payload = parseBody(init);
      try {
        const engine = engineFromStore();
        const result = engine.calculate(payload);
        return json(result, 200);
      } catch (e) {
        if (e instanceof window.PricingError) {
          return json({ detail: { message: e.message } }, 400);
        }
        console.error(e);
        return json({ detail: { message: "Internal error during calculation." } }, 500);
      }
    }

    // ----- admin prices -----
    if (pathname === "/api/admin/prices") {
      if (method === "GET") {
        const cfg = window.LocalStore.getConfig();
        return json({
          constants: cfg.constants,
          periods: cfg.periods,
          categories: cfg.categories,
          prices: cfg.prices,
        });
      }
      if (method === "POST") {
        const payload = parseBody(init);
        try {
          window.LocalStore.saveConfig(payload);
          return json({ status: "ok" });
        } catch (e) {
          const msg = (e instanceof window.PricingError) ? e.message : "Invalid pricing structure.";
          return json({ detail: { message: msg } }, 400);
        }
      }
    }

    // ----- gemini key -----
    if (pathname === "/api/admin/gemini-key") {
      if (method === "GET") {
        const key = window.LocalStore.getGeminiKey();
        return json({ configured: !!key, key_file: "локально (на устройстве)" });
      }
      if (method === "POST") {
        const payload = parseBody(init);
        window.LocalStore.setGeminiKey(payload.api_key);
        return json({ status: "ok" });
      }
    }

    // ----- AI parse -----
    if (pathname === "/api/parse" && method === "POST") {
      const payload = parseBody(init);
      try {
        const engine = engineFromStore();
        const result = await window.LocalParse.parseMessage(
          payload.message || "",
          window.LocalStore.getGeminiKey(),
          engine.categoriesMeta()
        );
        return json(result, 200);
      } catch (e) {
        console.error(e);
        return json({ error: "AI parsing unavailable", missing_fields: [] }, 200);
      }
    }

    // Unknown API route
    return json({ detail: { message: "Not found" } }, 404);
  }

  window.fetch = function (input, init) {
    let url;
    try {
      url = typeof input === "string" ? input : (input && input.url) || "";
    } catch (e) {
      url = "";
    }
    let pathname = "";
    try {
      pathname = new URL(url, window.location.href).pathname;
    } catch (e) {
      pathname = url;
    }

    if (pathname.indexOf("/api/") === 0) {
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      return handle(pathname, method, init);
    }
    return origFetch(input, init);
  };
})();
