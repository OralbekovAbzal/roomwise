function $(id) {
  return document.getElementById(id);
}

function formatNumber(n) {
  if (n == null || isNaN(n)) return "–";
  return Number(n).toLocaleString("ru-RU");
}

// Live category config from /api/categories.
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
}

function nightsBetween(checkIn, checkOut) {
  var a = new Date(checkIn + "T00:00:00");
  var b = new Date(checkOut + "T00:00:00");
  var diff = Math.round((b - a) / 86400000);
  return diff > 0 ? diff : 0;
}

// Auto-save an AI-driven calculation into the offline history (IndexedDB).
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

async function handleParse() {
  var message = $("client-message").value.trim();
  var statusEl = $("parse-status");
  var missingEl = $("parse-missing");
  var resultText = $("result_text");
  var totalEl = $("total");
  var totalAfterEl = $("total_after_discount");
  var prepayEl = $("prepayment_amount");

  missingEl.style.display = "none";
  missingEl.textContent = "";
  resultText.value = "";
  totalEl.textContent = "–";
  totalAfterEl.textContent = "–";
  prepayEl.textContent = "–";

  if (!message) {
    statusEl.textContent = "Введите сообщение клиента";
    return;
  }

  var parseBtn = $("parse-btn");
  if (parseBtn) { parseBtn.disabled = true; parseBtn.textContent = "Разбор…"; }
  statusEl.textContent = "Разбор…";
  try {
    var parseRes = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message }),
    });
    var parsed = await parseRes.json();

    if (parsed.error) {
      statusEl.textContent = parsed.error;
      if (parsed.missing_fields && parsed.missing_fields.length > 0) {
        missingEl.textContent = "Не указано: " + parsed.missing_fields.join(", ");
        missingEl.style.display = "block";
      }
      if (parseBtn) { parseBtn.disabled = false; parseBtn.textContent = "Разобрать"; }
      return;
    }

    statusEl.textContent = "Расчёт…";
    var adults_meal = parsed.adults_meal || 0;
    var children_meal = parsed.children_meal || 0;
    var adults_no_meal = parsed.adults_no_meal || 0;
    var children_no_meal = parsed.children_no_meal || 0;
    var totalGuests = adults_meal + children_meal + adults_no_meal + children_no_meal;
    var room_size = Math.max(1, Number(parsed.room_size) || 2);

    var extra_bed_meal = Number(parsed.extra_bed_meal) || 0;
    if (extra_bed_meal === 0) {
      extra_bed_meal = Number(parsed.extra_bed_count) || 0;
    }
    extra_bed_meal = Math.max(0, extra_bed_meal);
    var extra_bed_no_meal = Math.max(0, Number(parsed.extra_bed_no_meal) || 0);
    var category = parsed.category || (categoriesConfig[0] && categoriesConfig[0].id) || "standard";
    var catCfg = getCategoryConfig(category);
    var allowExtra = !!(catCfg && catCfg.allow_extra_beds);

    // Extra beds only count for categories that allow them.
    if (!allowExtra) {
      extra_bed_meal = 0;
      extra_bed_no_meal = 0;
    }
    var extra_bed_total = extra_bed_meal + extra_bed_no_meal;

    if (totalGuests > 0) {
      var allowed = (catCfg && catCfg.room_sizes && catCfg.room_sizes.length)
        ? catCfg.room_sizes.slice().sort(function (a, b) { return a - b; })
        : [2, 3, 4, 5];
      var maxAllowed = Math.max.apply(null, allowed);
      if (allowExtra) {
        var capacity = room_size + extra_bed_total;
        if (capacity < totalGuests) {
          room_size = Math.min(maxAllowed, Math.max(allowed[0], totalGuests - extra_bed_total));
        }
      } else if (room_size < totalGuests) {
        room_size = allowed.find(function (n) { return n >= totalGuests; }) || maxAllowed;
      }
    }

    var prepayPercent = parsed.prepayment_percent != null ? parsed.prepayment_percent : 50;
    var discountPercent = parsed.discount_percent != null ? parsed.discount_percent : 0;

    var calcPayload = {
      category: category,
      room_size: room_size,
      extra_bed_meal: extra_bed_meal,
      extra_bed_no_meal: extra_bed_no_meal,
      adults_meal: adults_meal,
      children_meal: children_meal,
      adults_no_meal: adults_no_meal,
      children_no_meal: children_no_meal,
      has_disabled: parsed.has_disabled || false,
      disabled_adults: parsed.disabled_adults || 0,
      disabled_children: parsed.disabled_children || 0,
      check_in: parsed.check_in,
      check_out: parsed.check_out,
      prepayment_percent: prepayPercent,
      discount_percent: discountPercent,
    };

    var calcRes = await fetch("/api/calc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calcPayload),
    });
    var calcData = await calcRes.json();

    if (!calcRes.ok) {
      var msg =
        (calcData && calcData.detail && calcData.detail.message) ||
        calcData.detail ||
        "Ошибка расчёта";
      statusEl.textContent = msg;
      if (parseBtn) { parseBtn.disabled = false; parseBtn.textContent = "Разобрать"; }
      return;
    }

    resultText.value = calcData.result_text || "";
    totalEl.textContent = formatNumber(calcData.total);
    totalAfterEl.textContent = formatNumber(calcData.total_after_discount);
    prepayEl.textContent = formatNumber(calcData.prepayment_amount);
    saveToHistory(calcPayload, calcData);
    statusEl.textContent = "Готово";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Ошибка сети или сервера";
  } finally {
    if (parseBtn) { parseBtn.disabled = false; parseBtn.textContent = "Разобрать"; }
  }
}

async function handleCopy() {
  var text = $("result_text").value;
  var indicator = $("copy-indicator");
  if (!text) {
    indicator.textContent = "Нечего копировать";
    setTimeout(function () { indicator.textContent = ""; }, 1500);
    return;
  }
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      indicator.textContent = "Скопировано";
    } catch (e) {
      indicator.textContent = "Ошибка копирования";
    }
  } else {
    var ta = $("result_text");
    ta.focus();
    ta.select();
    try {
      var ok = document.execCommand("copy");
      indicator.textContent = ok ? "Скопировано" : "Ошибка копирования";
    } catch (e) {
      indicator.textContent = "Ошибка копирования";
    }
  }
  setTimeout(function () { indicator.textContent = ""; }, 1500);
}

document.addEventListener("DOMContentLoaded", function () {
  var parseBtn = document.getElementById("parse-btn");
  var copyBtn = document.getElementById("copy-btn");
  if (parseBtn) parseBtn.addEventListener("click", handleParse);
  if (copyBtn) copyBtn.addEventListener("click", handleCopy);
  loadCategories();
});
