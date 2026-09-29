function $(id) {
  return document.getElementById(id);
}

function formatNumber(n) {
  if (n == null || isNaN(n)) return "–";
  return Number(n).toLocaleString("ru-RU");
}

// Live category config from /api/categories: [{id,label,room_sizes,allow_extra_beds}]
var categoriesConfig = [];

function getCategoryConfig(id) {
  for (var i = 0; i < categoriesConfig.length; i++) {
    if (categoriesConfig[i].id === id) return categoriesConfig[i];
  }
  return null;
}

async function loadCategories() {
  try {
    var res = await fetch("/api/categories");
    var data = await res.json();
    categoriesConfig = (data && data.categories) || [];
  } catch (err) {
    console.error(err);
    categoriesConfig = [];
  }
  var sel = $("category");
  if (sel) {
    var previous = sel.value;
    sel.innerHTML = "";
    categoriesConfig.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.label;
      sel.appendChild(opt);
    });
    if (previous && getCategoryConfig(previous)) sel.value = previous;
  }
}

function updateVisibility() {
  var catEl = document.getElementById("category");
  if (!catEl) return;
  var cfg = getCategoryConfig(catEl.value);
  var allowExtra = !!(cfg && cfg.allow_extra_beds);

  var extraBedHeading = document.getElementById("extra-bed-heading");
  var extraBedField = document.getElementById("extra-bed-field");
  if (extraBedHeading) extraBedHeading.style.display = allowExtra ? "block" : "none";
  if (extraBedField) extraBedField.style.display = allowExtra ? "grid" : "none";
  // When extra beds are not allowed, never send stale values to the calculator.
  if (!allowExtra) {
    var em = $("extra_bed_meal"); if (em) em.value = 0;
    var enm = $("extra_bed_no_meal"); if (enm) enm.value = 0;
  }

  var roomSize = document.getElementById("room_size");
  if (!roomSize) return;
  var previous = roomSize.value;
  var options = (cfg && cfg.room_sizes && cfg.room_sizes.length) ? cfg.room_sizes : [];
  roomSize.innerHTML = "";
  options.forEach(function (n) {
    var opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    roomSize.appendChild(opt);
  });
  if (options.indexOf(Number(previous)) !== -1) roomSize.value = previous;
}

function updateDisabledVisibility() {
  var hasDisabled = document.getElementById("has_disabled");
  var container = document.getElementById("disabled-fields");
  if (container && hasDisabled) container.style.display = hasDisabled.checked ? "grid" : "none";
}

function setVal(id, value) {
  var el = $(id);
  if (el && value != null) el.value = value;
}
function setCheck(id, value) {
  var el = $(id);
  if (el) el.checked = !!value;
}

function applyParsedData(data) {
  if (!data) return;
  if (data.category != null && getCategoryConfig(data.category)) {
    setVal("category", data.category);
    updateVisibility();
  }
  if (data.room_size != null && data.room_size >= 1) {
    var roomSize = $("room_size");
    if (roomSize && roomSize.options) {
      var opts = Array.from(roomSize.options).map(function (o) { return Number(o.value); });
      if (opts.indexOf(data.room_size) !== -1) roomSize.value = String(data.room_size);
    }
  }
  setVal("extra_bed_meal", Math.max(0, Number(data.extra_bed_meal) || Number(data.extra_bed_count) || 0));
  setVal("extra_bed_no_meal", Math.max(0, Number(data.extra_bed_no_meal) || 0));
  setVal("adults_meal", Math.max(0, Number(data.adults_meal) || 0));
  setVal("children_meal", Math.max(0, Number(data.children_meal) || 0));
  setVal("adults_no_meal", Math.max(0, Number(data.adults_no_meal) || 0));
  setVal("children_no_meal", Math.max(0, Number(data.children_no_meal) || 0));
  setCheck("has_disabled", data.has_disabled);
  setVal("disabled_adults", Math.max(0, Number(data.disabled_adults) || 0));
  setVal("disabled_children", Math.max(0, Number(data.disabled_children) || 0));
  if (data.check_in) setVal("check_in", data.check_in);
  if (data.check_out) setVal("check_out", data.check_out);
  var prep = Number(data.prepayment_percent);
  if (Number.isFinite(prep) && prep >= 0 && prep <= 100) setVal("prepayment_percent", prep);
  var disc = Number(data.discount_percent);
  if (Number.isFinite(disc) && disc >= 0 && disc <= 100) setVal("discount_percent", disc);
  updateVisibility();
  updateDisabledVisibility();
}

function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (!params.toString()) return;
  const set = (id, value) => {
    const el = $(id);
    if (el && value != null && String(value).trim() !== "") el.value = value;
  };
  set("category", params.get("category"));
  set("room_size", params.get("room_size"));
  set("extra_bed_meal", params.get("extra_bed_meal"));
  set("extra_bed_no_meal", params.get("extra_bed_no_meal"));
  set("adults_meal", params.get("adults_meal"));
  set("children_meal", params.get("children_meal"));
  set("adults_no_meal", params.get("adults_no_meal"));
  set("children_no_meal", params.get("children_no_meal"));
  set("check_in", params.get("check_in"));
  set("check_out", params.get("check_out"));
  set("discount_percent", params.get("discount_percent"));
  set("prepayment_percent", params.get("prepayment_percent"));
  set("disabled_adults", params.get("disabled_adults"));
  set("disabled_children", params.get("disabled_children"));
  var hasDisabledEl = document.getElementById("has_disabled");
  if (hasDisabledEl) {
    var hasDisabled = params.get("has_disabled");
    if (hasDisabled !== null) hasDisabledEl.checked = hasDisabled === "true" || hasDisabled === "1";
  }
  updateVisibility();
  updateDisabledVisibility();
}

function setStatus(text) {
  var el = $("status");
  if (el) el.textContent = text;
}

function nightsBetween(checkIn, checkOut) {
  var a = new Date(checkIn + "T00:00:00");
  var b = new Date(checkOut + "T00:00:00");
  var diff = Math.round((b - a) / 86400000);
  return diff > 0 ? diff : 0;
}

// Auto-save a successful calculation into the offline history (IndexedDB).
function saveToHistory(payload, data) {
  if (!window.HistoryDB) return;
  var cfg = getCategoryConfig(payload.category);
  var record = {
    request: payload,
    categoryLabel: cfg ? cfg.label : payload.category,
    nights: nightsBetween(payload.check_in, payload.check_out),
    total: data.total,
    total_after_discount: data.total_after_discount,
    prepayment_amount: data.prepayment_amount,
    breakdown: data.breakdown || [],
    result_text: data.result_text || "",
  };
  try {
    window.HistoryDB.saveCalculation(record).catch(function (e) { console.error(e); });
  } catch (e) { console.error(e); }
}

async function handleSubmit(event) {
  event.preventDefault();
  var calcBtn = $("calc-btn");
  var checkInEl = $("check_in");
  var checkOutEl = $("check_out");
  var checkIn = (checkInEl && checkInEl.value) || "";
  var checkOut = (checkOutEl && checkOutEl.value) || "";
  if (!checkIn.trim() || !checkOut.trim()) {
    setStatus("Укажите даты заезда и выезда");
    return;
  }
  if (checkIn >= checkOut) {
    setStatus("Дата выезда должна быть позже даты заезда");
    return;
  }
  var getNum = function (id, def) { var el = $(id); return el ? Number(el.value || 0) : def; };
  var quickTotal = getNum("adults_meal", 0) + getNum("children_meal", 0) + getNum("adults_no_meal", 0) + getNum("children_no_meal", 0);
  if (quickTotal <= 0) {
    setStatus("Укажите хотя бы одного гостя");
    return;
  }
  var catVal = $("category") ? $("category").value : "";
  var catCfg = getCategoryConfig(catVal);
  var roomVal = $("room_size") ? Number($("room_size").value) : 0;
  var capacity = roomVal;
  if (catCfg && catCfg.allow_extra_beds) {
    capacity += getNum("extra_bed_meal", 0) + getNum("extra_bed_no_meal", 0);
  }
  if (quickTotal > capacity) {
    setStatus("Число гостей (" + quickTotal + ") превышает вместимость (" + capacity + ")");
    return;
  }
  if (calcBtn) { calcBtn.disabled = true; calcBtn.textContent = "Расчёт…"; }
  setStatus("Расчёт…");

  var categoryEl = $("category");
  var roomSizeEl = $("room_size");
  if (!categoryEl || !roomSizeEl) {
    setStatus("Ошибка: форма не найдена");
    if (calcBtn) { calcBtn.disabled = false; calcBtn.textContent = "Рассчитать"; }
    return;
  }

  var getVal = function (id, def) { var el = $(id); return el ? (el.value !== undefined ? el.value : def) : def; };
  var getCheck = function (id) { var el = $(id); return el ? !!el.checked : false; };
  var payload = {
    category: categoryEl.value,
    room_size: Number(roomSizeEl.value),
    extra_bed_meal: getNum("extra_bed_meal", 0),
    extra_bed_no_meal: getNum("extra_bed_no_meal", 0),
    adults_meal: getNum("adults_meal", 0),
    children_meal: getNum("children_meal", 0),
    adults_no_meal: getNum("adults_no_meal", 0),
    children_no_meal: getNum("children_no_meal", 0),
    has_disabled: getCheck("has_disabled"),
    disabled_adults: getNum("disabled_adults", 0),
    disabled_children: getNum("disabled_children", 0),
    check_in: getVal("check_in", ""),
    check_out: getVal("check_out", ""),
    prepayment_percent: getNum("prepayment_percent", 0),
    discount_percent: getNum("discount_percent", 0),
  };

  var apiBase = (window.location && window.location.origin) ? window.location.origin : "";
  try {
    var res = await fetch(apiBase + "/api/calc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    var data = {};
    try {
      data = await res.json();
    } catch (_) {
      if (!res.ok) {
        setStatus("Ошибка сервера. Код " + res.status);
        var t = $("total"); if (t) t.textContent = "–";
        var tad = $("total_after_discount"); if (tad) tad.textContent = "–";
        var pa = $("prepayment_amount"); if (pa) pa.textContent = "–";
        var rt = $("result_text"); if (rt) rt.value = "";
        if (calcBtn) { calcBtn.disabled = false; calcBtn.textContent = "Рассчитать"; }
        return;
      }
    }

    if (!res.ok) {
      var msg = "Ошибка расчёта";
      if (data && data.detail) {
        if (typeof data.detail === "string") msg = data.detail;
        else if (data.detail.message) msg = data.detail.message;
        else if (Array.isArray(data.detail) && data.detail.length > 0)
          msg = data.detail.map(function (e) { return e.msg || e.message || JSON.stringify(e); }).join("; ");
      }
      setStatus(msg);
      t = $("total"); if (t) t.textContent = "–";
      tad = $("total_after_discount"); if (tad) tad.textContent = "–";
      pa = $("prepayment_amount"); if (pa) pa.textContent = "–";
      rt = $("result_text"); if (rt) rt.value = "";
      if (calcBtn) { calcBtn.disabled = false; calcBtn.textContent = "Рассчитать"; }
      return;
    }

    rt = $("result_text"); if (rt) rt.value = data.result_text || "";
    t = $("total"); if (t) t.textContent = formatNumber(data.total);
    tad = $("total_after_discount"); if (tad) tad.textContent = formatNumber(data.total_after_discount);
    pa = $("prepayment_amount"); if (pa) pa.textContent = formatNumber(data.prepayment_amount);
    saveToHistory(payload, data);
    setStatus("Готово");
  } catch (err) {
    console.error(err);
    setStatus("Ошибка сети или сервера");
    var t = $("total"); if (t) t.textContent = "–";
    var tad = $("total_after_discount"); if (tad) tad.textContent = "–";
    var pa = $("prepayment_amount"); if (pa) pa.textContent = "–";
  } finally {
    if (calcBtn) { calcBtn.disabled = false; calcBtn.textContent = "Рассчитать"; }
  }
}

async function handleCopy() {
  const text = $("result_text").value;
  const indicator = $("copy-indicator");
  if (!text) {
    indicator.textContent = "Нечего копировать";
    setTimeout(() => (indicator.textContent = ""), 1500);
    return;
  }

  // Prefer modern async clipboard if available and allowed
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      indicator.textContent = "Скопировано";
    } catch {
      indicator.textContent = "Ошибка копирования";
    }
  } else {
    // Fallback for non-secure HTTP / older browsers:
    const textarea = $("result_text");
    const previousSelectionStart = textarea.selectionStart;
    const previousSelectionEnd = textarea.selectionEnd;
    const previousActive = document.activeElement;

    textarea.focus();
    textarea.select();
    try {
      const ok = document.execCommand("copy");
      indicator.textContent = ok ? "Скопировано" : "Ошибка копирования";
    } catch {
      indicator.textContent = "Copy failed";
    } finally {
      // Restore selection / focus so we don't annoy the user
      if (previousActive && typeof previousActive.focus === "function") {
        previousActive.focus();
      }
      if (typeof previousSelectionStart === "number" && typeof previousSelectionEnd === "number") {
        textarea.setSelectionRange(previousSelectionStart, previousSelectionEnd);
      }
    }
  }
  setTimeout(() => (indicator.textContent = ""), 1500);
}

document.addEventListener("DOMContentLoaded", function () {
  try {
    var form = document.getElementById("calc-form");
    var category = document.getElementById("category");
    var hasDisabled = document.getElementById("has_disabled");
    var copyBtn = document.getElementById("copy-btn");

    if (category) category.addEventListener("change", updateVisibility);
    if (hasDisabled) hasDisabled.addEventListener("change", updateDisabledVisibility);
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        handleSubmit(e);
      });
    }
    if (copyBtn) copyBtn.addEventListener("click", handleCopy);
  } finally {
    // Set readiness synchronously (before any await) so the load-time guard
    // in index.html does not mistake async category loading for a dead script.
    window.__turanAppReady = true;
  }

  // Categories load asynchronously; apply parsed/URL data once options exist.
  (async function () {
    await loadCategories();
    try {
      var stored = sessionStorage.getItem("turanParsedBooking");
      if (stored) {
        sessionStorage.removeItem("turanParsedBooking");
        applyParsedData(JSON.parse(stored));
      }
    } catch (err) { /* ignore */ }
    applyUrlParams();
    updateVisibility();
    updateDisabledVisibility();
  })();
});

