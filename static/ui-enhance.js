/*
 * ui-enhance.js — progressive glass-UI enhancements for the calculator screen.
 * Adds the category chip rail and +/- steppers WITHOUT touching app.js logic:
 * it drives the existing #category <select> and the numeric inputs (same ids).
 * Everything is defensive — if an element is missing it silently skips.
 */
(function () {
  "use strict";

  var STEPPER_IDS = [
    "adults_meal", "children_meal",
    "adults_no_meal", "children_no_meal",
    "extra_bed_meal", "extra_bed_no_meal",
  ];

  function fmt(n) {
    return Number(n).toLocaleString("ru-RU");
  }

  /* ---------- +/- steppers around numeric guest inputs ---------- */
  function buildSteppers() {
    STEPPER_IDS.forEach(function (id) {
      var input = document.getElementById(id);
      if (!input || input.closest(".rw-stepper")) return;

      var wrap = document.createElement("div");
      wrap.className = "rw-stepper";
      input.parentNode.insertBefore(wrap, input);

      var minus = document.createElement("button");
      minus.type = "button";
      minus.textContent = "−";
      minus.setAttribute("aria-label", "Уменьшить");

      var plus = document.createElement("button");
      plus.type = "button";
      plus.textContent = "+";
      plus.setAttribute("aria-label", "Увеличить");

      wrap.appendChild(minus);
      wrap.appendChild(input);
      wrap.appendChild(plus);

      var step = function (delta) {
        var max = input.max ? Number(input.max) : 99;
        var min = input.min ? Number(input.min) : 0;
        var v = (Number(input.value) || 0) + delta;
        if (v < min) v = min;
        if (v > max) v = max;
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      minus.addEventListener("click", function () { step(-1); });
      plus.addEventListener("click", function () { step(1); });
    });
  }

  /* ---------- category chip rail ---------- */
  function minAdultPrice(prices, id) {
    try {
      var adult = prices[id].adult;
      var vals = Object.keys(adult).map(function (k) { return Number(adult[k]); });
      return vals.length ? Math.min.apply(null, vals) : null;
    } catch (e) { return null; }
  }

  function syncChips(rail, select) {
    var current = select.value;
    Array.prototype.forEach.call(rail.querySelectorAll(".rw-cat-chip"), function (chip) {
      var on = chip.getAttribute("data-id") === current;
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      var check = chip.querySelector(".rw-chip-check");
      if (check) check.style.display = on ? "inline-flex" : "none";
    });
  }

  async function buildCategoryRail() {
    var rail = document.getElementById("cat-rail");
    var select = document.getElementById("category");
    if (!rail || !select) return;

    var cats = [];
    var prices = {};
    try {
      var cRes = await fetch("/api/categories");
      cats = ((await cRes.json()).categories) || [];
      var pRes = await fetch("/api/admin/prices");
      prices = ((await pRes.json()).prices) || {};
    } catch (e) { console.error(e); }
    if (!cats.length) return;

    rail.innerHTML = "";
    cats.forEach(function (c) {
      var sizes = c.room_sizes || [];
      var capRange = sizes.length
        ? sizes[0] + (sizes.length > 1 ? "–" + sizes[sizes.length - 1] : "") + " чел"
        : "";
      var from = minAdultPrice(prices, c.id);

      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "rw-cat-chip";
      chip.setAttribute("data-id", c.id);
      chip.setAttribute("aria-pressed", "false");
      chip.innerHTML =
        '<div class="rw-chip-name"><span>' + c.label + "</span>" +
          '<span class="rw-chip-check" style="display:none">✓</span></div>' +
        '<div class="rw-chip-tags"><span class="rw-chip-cap">' + capRange + "</span>" +
          (c.allow_extra_beds ? '<span class="rw-chip-cap rw-chip-extra">+ доп. места</span>' : "") +
        "</div>" +
        (from != null
          ? '<div class="rw-chip-price">от <span class="rw-chip-from">' + fmt(from) + "</span> ₸</div>"
          : "");

      chip.addEventListener("click", function () {
        if (!select.querySelector('option[value="' + c.id + '"]')) return;
        select.value = c.id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncChips(rail, select);
      });
      rail.appendChild(chip);
    });

    // Keep chips in sync when category changes elsewhere (parsed data, etc.)
    select.addEventListener("change", function () { syncChips(rail, select); });
    // Initial sync once app.js has populated the <select>.
    setTimeout(function () { syncChips(rail, select); }, 300);
    // Chips are the visible selector → hide the redundant <select> field.
    var field = document.getElementById("category-field");
    if (field) field.style.display = "none";
  }

  /* ---------- capacity segmented control (mirrors #room_size <select>) ---------- */
  function renderCapacitySeg() {
    var seg = document.getElementById("room_size_seg");
    var select = document.getElementById("room_size");
    if (!seg || !select) return;
    select.style.display = "none";
    seg.innerHTML = "";
    Array.prototype.forEach.call(select.options, function (opt) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = opt.text;
      b.setAttribute("aria-selected", opt.value === select.value ? "true" : "false");
      b.addEventListener("click", function () {
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        Array.prototype.forEach.call(seg.querySelectorAll("button"), function (x) {
          x.setAttribute("aria-selected", x === b ? "true" : "false");
        });
      });
      seg.appendChild(b);
    });
  }

  function wireCapacitySeg() {
    var select = document.getElementById("room_size");
    var category = document.getElementById("category");
    if (!select) return;
    // Rebuild after the category change handler (app.js) repopulates sizes.
    if (category) {
      category.addEventListener("change", function () {
        setTimeout(renderCapacitySeg, 0);
      });
    }
    setTimeout(renderCapacitySeg, 350); // initial, once app.js fills the <select>
  }

  document.addEventListener("DOMContentLoaded", function () {
    try { buildSteppers(); } catch (e) { console.error(e); }
    try { buildCategoryRail(); } catch (e) { console.error(e); }
    try { wireCapacitySeg(); } catch (e) { console.error(e); }
  });
})();
