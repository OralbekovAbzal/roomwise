/*
 * local-parse.js — client-side port of parse.py.
 * Calls the Gemini REST API directly from the device (online only). All pricing
 * stays local; the AI only extracts structured booking data.
 * Exposes: window.LocalParse.parseMessage(message, apiKey, categories) -> Promise.
 */
(function () {
  "use strict";

  const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
  const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"];

  function categoriesPromptBlock(categories) {
    if (!categories || !categories.length) {
      return {
        listing: "- econom, standard, comfort",
        idUnion: '"econom" | "standard" | "comfort" | null',
        extraRule: "EXTRA BED (доп. место) — only for comfort.",
      };
    }
    const lines = [];
    const extraIds = [];
    categories.forEach(function (c) {
      const cid = String(c.id);
      const label = String(c.label || cid);
      const sizes = (c.room_sizes || []).join(", ");
      const allow = !!c.allow_extra_beds;
      if (allow) extraIds.push(cid);
      const note = allow ? " — allows extra beds (доп. места)" : "";
      lines.push('- id "' + cid + '" (label "' + label + '"): room sizes ' + sizes + note);
    });
    const idUnion = categories.map(function (c) { return '"' + String(c.id) + '"'; }).join(" | ") + " | null";
    let extraRule;
    if (extraIds.length) {
      extraRule =
        "EXTRA BED (доп. место) — only for categories that allow extra beds (" + extraIds.join(", ") + "):\n" +
        "- A guest on an extra bed is counted ONLY in extra_bed_count (or extra_bed_meal/extra_bed_no_meal), NOT in children_meal/children_no_meal. Never count the same person twice.\n" +
        '- If the client says "доп место" / "доп. кровать" / "на доп" / "extra bed", put that person ONLY in extra_bed_count.\n' +
        '- For an extra-bed category, if the client does NOT say "основное"/"доп", treat a third person (e.g. a child) as an extra bed by default.\n' +
        "- For categories that do NOT allow extra beds, always set extra_bed_count/extra_bed_meal/extra_bed_no_meal to 0 and count everyone as adults/children.";
    } else {
      extraRule = "EXTRA BED (доп. место): no category currently allows extra beds — always set extra_bed_count, extra_bed_meal and extra_bed_no_meal to 0.";
    }
    return { listing: lines.join("\n"), idUnion: idUnion, extraRule: extraRule };
  }

  function buildParsePrompt(categories) {
    const b = categoriesPromptBlock(categories);
    const year = new Date().getFullYear();
    return (
"You are a booking data extractor. Extract structured fields from the user's message and return valid JSON only.\n\n" +
"LANGUAGE: The user message may be in Russian, English, Kazakh, or any other language. Interpret all languages correctly. Guests: взрослые/adults, дети/children/kids, с питанием/with meal, без питания/no meal. Dates may be in DD.MM.YYYY, DD/MM/YYYY, or text. Convert everything to the output format below.\n\n" +
'CATEGORIES (use the id as the value of "category"; match the client\'s words to the closest label/id):\n' + b.listing + "\n\n" +
"AGE RULE (important): In our hotel, guests aged 14 years or older are charged as ADULTS; only under 14 are charged as children. If the message gives ages, count 14+ as adult and under 14 as child.\n\n" +
"ROOM SIZE: If the client does not specify room size/capacity, set room_size to the minimum allowed capacity of the chosen category that fits the total number of guests. Pick the smallest capacity that fits.\n\n" +
b.extraRule + "\n\n" +
"RULES:\n" +
"- Return ONLY a single JSON object. No markdown, no code fences, no explanation.\n" +
"- Do NOT calculate or estimate any prices or money.\n" +
"- If the room category is not clearly mentioned or does not match any category above, set \"category\" to null.\n" +
"- Dates must be in YYYY-MM-DD format. If year is missing, use the current year " + year + ".\n" +
"- Integer fields must be non-negative integers. Percentages between 0 and 100.\n" +
"- Defaults when not stated: guest counts 0, has_disabled false, disabled_* 0, prepayment_percent 50, discount_percent 0.\n" +
'- If required data is missing (no check-in/check-out, no category, or no guests), include "missing_fields" array.\n\n' +
"Output JSON shape (use exactly these keys):\n" +
"{\n" +
'  "category": ' + b.idUnion + ",\n" +
'  "room_size": 2,\n  "extra_bed_count": 0,\n  "extra_bed_meal": 0,\n  "extra_bed_no_meal": 0,\n' +
'  "adults_meal": 0,\n  "children_meal": 0,\n  "adults_no_meal": 0,\n  "children_no_meal": 0,\n' +
'  "has_disabled": false,\n  "disabled_adults": 0,\n  "disabled_children": 0,\n' +
'  "check_in": "YYYY-MM-DD" or null,\n  "check_out": "YYYY-MM-DD" or null,\n' +
'  "prepayment_percent": 50,\n  "discount_percent": 0,\n  "missing_fields": []\n}'
    );
  }

  function extractJson(text) {
    if (!text) return null;
    let t = text.trim();
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) t = m[1].trim();
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  function validateDates(ci, co) {
    if (!ci || !co) return false;
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(ci) || !re.test(co)) return false;
    const d1 = new Date(ci + "T00:00:00Z");
    const d2 = new Date(co + "T00:00:00Z");
    return d2.getTime() > d1.getTime();
  }

  function asInt(v) { const n = parseInt(v, 10); return isNaN(n) || n < 0 ? 0 : n; }

  function requiredMissing(p) {
    const missing = [];
    if (p.category == null) missing.push("category");
    if (p.room_size == null || p.room_size < 1) missing.push("room_size");
    if (!p.check_in || !p.check_out) {
      if (!p.check_in) missing.push("check_in");
      if (!p.check_out) missing.push("check_out");
    } else if (!validateDates(p.check_in, p.check_out)) {
      missing.push("check_in");
    }
    const guests = asInt(p.adults_meal) + asInt(p.children_meal) + asInt(p.adults_no_meal) + asInt(p.children_no_meal);
    if (guests <= 0) missing.push("guests");
    return missing;
  }

  async function callGemini(message, apiKey, systemPrompt) {
    const prompt = systemPrompt + "\n\nUser message:\n" + message;
    let lastError = null;
    for (let i = 0; i < MODELS.length; i++) {
      const url = ENDPOINT + MODELS[i] + ":generateContent?key=" + encodeURIComponent(apiKey);
      try {
        const res = await window.__origFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
          }),
        });
        if (!res.ok) {
          lastError = new Error("HTTP " + res.status);
          if (res.status === 404 || res.status === 429) continue;
          throw lastError;
        }
        const data = await res.json();
        const text = data && data.candidates && data.candidates[0] &&
          data.candidates[0].content && data.candidates[0].content.parts &&
          data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
        if (text) return text;
        lastError = new Error("Empty response from Gemini");
      } catch (e) {
        lastError = e;
        const msg = String(e && e.message || e);
        if (msg.indexOf("404") !== -1 || msg.indexOf("429") !== -1) continue;
        throw e;
      }
    }
    throw lastError || new Error("Empty response from Gemini");
  }

  function buildSuccess(raw) {
    const hasDisabled = !!raw.has_disabled;
    let extraMeal = asInt(raw.extra_bed_meal);
    let extraNoMeal = asInt(raw.extra_bed_no_meal);
    if (extraMeal === 0 && extraNoMeal === 0) extraMeal = asInt(raw.extra_bed_count);
    return {
      category: raw.category != null ? String(raw.category) : null,
      room_size: asInt(raw.room_size) || 2,
      extra_bed_count: asInt(raw.extra_bed_count),
      extra_bed_meal: extraMeal,
      extra_bed_no_meal: extraNoMeal,
      adults_meal: asInt(raw.adults_meal),
      children_meal: asInt(raw.children_meal),
      adults_no_meal: asInt(raw.adults_no_meal),
      children_no_meal: asInt(raw.children_no_meal),
      has_disabled: hasDisabled,
      disabled_adults: hasDisabled ? asInt(raw.disabled_adults) : 0,
      disabled_children: hasDisabled ? asInt(raw.disabled_children) : 0,
      check_in: raw.check_in,
      check_out: raw.check_out,
      prepayment_percent: raw.prepayment_percent != null ? asInt(raw.prepayment_percent) : 50,
      discount_percent: asInt(raw.discount_percent),
      missing_fields: [],
    };
  }

  async function parseMessage(message, apiKey, categories) {
    if (!apiKey || !apiKey.trim()) {
      return { error: "AI parsing unavailable", missing_fields: [] };
    }
    const systemPrompt = buildParsePrompt(categories);
    const knownIds = (categories || []).map(function (c) { return String(c.id); });

    let raw = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callGemini(message, apiKey, systemPrompt);
        raw = extractJson(text);
        if (raw) break;
        lastError = "Invalid JSON from model";
      } catch (e) {
        lastError = String(e && e.message || e);
        if (attempt === 0) continue;
        return { error: "AI parsing unavailable", missing_fields: [] };
      }
    }
    if (!raw) return { error: lastError || "Invalid JSON from model", missing_fields: [] };

    // Reject a category the AI invented that isn't in the live config.
    if (knownIds.length && knownIds.indexOf(raw.category != null ? String(raw.category) : "") === -1) {
      raw.category = null;
    }

    const missing = requiredMissing(raw);
    if (missing.length) {
      return { error: "Missing required fields", missing_fields: missing };
    }
    return buildSuccess(raw);
  }

  window.LocalParse = {
    parseMessage: parseMessage,
    buildParsePrompt: buildParsePrompt,
  };
})();
