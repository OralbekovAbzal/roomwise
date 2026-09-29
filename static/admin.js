function $(id) {
  return document.getElementById(id);
}

let currentPricing = null;

// Capacities offered in the per-category checklist.
const CAPACITY_OPTIONS = [1, 2, 3, 4, 5, 6];

const TYPE_LABELS = {
  adult: "Взрослый",
  child: "Ребёнок",
  extra_bed: "Доп. место",
};

function periodIds() {
  if (!currentPricing || !currentPricing.periods) return [];
  return currentPricing.periods.map((p) => p.id);
}

function formatPeriodLabel(period) {
  // period.start like "06-15" -> "15.06"
  const [mm, dd] = (period.start || "").split("-");
  const [mmEnd, ddEnd] = (period.end || "").split("-");
  return `${dd}.${mm}–${ddEnd}.${mmEnd}`;
}

// Periods are year-agnostic: stored strictly as "MM-DD" (День/Месяц), since the
// price grid is seasonal and must work for any year. The editor uses day + month
// selects — no year is shown or chosen anywhere.
const MONTHS_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function pad2(n) { return String(n).padStart(2, "0"); }
function maxDay(mm) { return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(mm || 1) - 1]; }
function clampDay(mm, dd) {
  const md = maxDay(mm);
  return dd > md ? md : (dd < 1 ? 1 : dd);
}

// Sort periods chronologically by start date (MM-DD strings sort correctly).
function sortPeriods() {
  if (currentPricing && Array.isArray(currentPricing.periods)) {
    currentPricing.periods.sort(function (a, b) {
      var as = String(a.start || ""), bs = String(b.start || "");
      if (as < bs) return -1;
      if (as > bs) return 1;
      // tie-break by end date so identical starts stay stable
      return String(a.end || "") < String(b.end || "") ? -1 : 1;
    });
  }
}

// Day + month select pair for one endpoint. idPrefix e.g. "period-start-p1".
function dmSelectHtml(idPrefix, mmdd) {
  const parts = String(mmdd || "06-01").split("-");
  let mm = parseInt(parts[0], 10) || 6;
  let dd = clampDay(mm, parseInt(parts[1], 10) || 1);
  let dayOpts = "";
  for (let d = 1; d <= maxDay(mm); d++) {
    dayOpts += `<option value="${pad2(d)}"${d === dd ? " selected" : ""}>${d}</option>`;
  }
  let monOpts = "";
  for (let m = 1; m <= 12; m++) {
    monOpts += `<option value="${pad2(m)}"${m === mm ? " selected" : ""}>${MONTHS_RU[m - 1]}</option>`;
  }
  return (
    `<select id="${idPrefix}-day" class="rw-dm-day" aria-label="День">${dayOpts}</select>` +
    `<select id="${idPrefix}-mon" class="rw-dm-mon" aria-label="Месяц">${monOpts}</select>`
  );
}

// Read a day+month select pair back into "MM-DD" (clamped to a valid day).
function readDm(idPrefix) {
  const dayEl = $(`${idPrefix}-day`);
  const monEl = $(`${idPrefix}-mon`);
  if (!dayEl || !monEl) return null;
  const mm = parseInt(monEl.value, 10) || 6;
  const dd = clampDay(mm, parseInt(dayEl.value, 10) || 1);
  return pad2(mm) + "-" + pad2(dd);
}

function findCategory(id) {
  return (currentPricing.categories || []).find((c) => c.id === id) || null;
}

/* ---- Read current DOM inputs back into the in-memory model ---------------- */
function syncFromInputs() {
  if (!currentPricing) return;
  const pids = periodIds();

  // Meal price (global)
  if (!currentPricing.constants) currentPricing.constants = {};
  const mealEl = $("meal-price");
  if (mealEl) {
    const v = Number(mealEl.value);
    currentPricing.constants.meal_price = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  }

  // Period date ranges (day + month selects → "MM-DD")
  (currentPricing.periods || []).forEach((p) => {
    const start = readDm(`period-start-${p.id}`);
    const end = readDm(`period-end-${p.id}`);
    if (start) p.start = start;
    if (end) p.end = end;
  });

  (currentPricing.categories || []).forEach((c) => {
    const labelEl = $(`cat-label-${c.id}`);
    if (labelEl) c.label = labelEl.value.trim() || c.id;

    const sizes = [];
    CAPACITY_OPTIONS.forEach((n) => {
      const el = $(`cat-size-${c.id}-${n}`);
      if (el && el.checked) sizes.push(n);
    });
    if (sizes.length) c.room_sizes = sizes;

    const extraEl = $(`cat-extra-${c.id}`);
    if (extraEl) c.allow_extra_beds = extraEl.checked;

    const disEl = $(`cat-disabled-${c.id}`);
    if (disEl) {
      const v = Number(disEl.value);
      c.disabled_discount = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
    }
  });

  // Price inputs
  Object.keys(currentPricing.prices || {}).forEach((catId) => {
    const catPrices = currentPricing.prices[catId];
    Object.keys(catPrices).forEach((type) => {
      pids.forEach((pid) => {
        const el = $(`price-${catId}-${type}-${pid}`);
        if (el) {
          const v = Number(el.value);
          catPrices[type][pid] = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
        }
      });
    });
  });
}

/* ---- Keep prices structurally consistent with categories ------------------ */
function reconcilePrices() {
  if (!currentPricing) return;
  sortPeriods(); // chronological order → table columns follow date order
  const pids = periodIds();
  if (!currentPricing.prices) currentPricing.prices = {};

  const pidSet = new Set(pids);
  (currentPricing.categories || []).forEach((c) => {
    const p = currentPricing.prices[c.id] || (currentPricing.prices[c.id] = {});
    const types = c.allow_extra_beds ? ["adult", "child", "extra_bed"] : ["adult", "child"];
    types.forEach((t) => {
      if (!p[t]) p[t] = {};
      pids.forEach((pid) => {
        const v = Number(p[t][pid]);
        p[t][pid] = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
      });
      // Drop prices for periods that no longer exist
      Object.keys(p[t]).forEach((pid) => {
        if (!pidSet.has(pid)) delete p[t][pid];
      });
    });
    if (!c.allow_extra_beds) delete p.extra_bed;
  });

  // Drop prices for categories that were deleted
  Object.keys(currentPricing.prices).forEach((id) => {
    if (!findCategory(id)) delete currentPricing.prices[id];
  });
}

/* ---- Render: categories editor + price table ------------------------------ */
function renderCategoriesEditor() {
  const container = $("categories-editor");
  if (!container || !currentPricing) return;
  const cats = currentPricing.categories || [];

  if (!cats.length) {
    container.innerHTML = '<span class="status">Категорий нет. Добавьте первую.</span>';
    return;
  }

  let html = "";
  cats.forEach((c) => {
    const sizeBoxes = CAPACITY_OPTIONS.map((n) => {
      const checked = (c.room_sizes || []).indexOf(n) !== -1 ? "checked" : "";
      return `<label class="cap-box"><input type="checkbox" id="cat-size-${c.id}-${n}" ${checked} /> ${n}</label>`;
    }).join("");

    html += `
      <div class="category-card" data-id="${c.id}">
        <div class="category-card-head">
          <input type="text" id="cat-label-${c.id}" class="cat-label-input" value="${(c.label || "").replace(/"/g, "&quot;")}" placeholder="Название категории" />
          <button type="button" class="btn-danger delete-category" data-id="${c.id}">Удалить</button>
        </div>
        <div class="category-card-body">
          <div class="cat-row">
            <span class="cat-row-label">Вместимость (мест)</span>
            <div class="cap-list">${sizeBoxes}</div>
          </div>
          <div class="cat-row">
            <label class="toggle">
              <input type="checkbox" id="cat-extra-${c.id}" ${c.allow_extra_beds ? "checked" : ""} />
              Разрешить доп. места
            </label>
            <label class="cat-disabled">
              Скидка ОВ
              <input type="number" id="cat-disabled-${c.id}" min="0" value="${Number(c.disabled_discount) || 0}" />
            </label>
          </div>
        </div>
      </div>`;
  });
  container.innerHTML = html;
}

function renderMealPrice() {
  const el = $("meal-price");
  if (!el || !currentPricing) return;
  const c = currentPricing.constants || {};
  const v = c.meal_price != null ? c.meal_price : (c.no_meal_discount != null ? c.no_meal_discount : 0);
  el.value = Number(v) || 0;
}

function renderPeriodsEditor() {
  const container = $("periods-editor");
  if (!container || !currentPricing) return;
  const periods = currentPricing.periods || [];

  if (!periods.length) {
    container.innerHTML = '<span class="status">Периодов нет. Добавьте первый.</span>';
    return;
  }

  let html = "";
  periods.forEach((p) => {
    html += `
      <div class="period-card" data-id="${p.id}">
        <div class="period-dates">
          <div class="field">
            <span>Начало</span>
            <div class="rw-dm">${dmSelectHtml(`period-start-${p.id}`, p.start)}</div>
          </div>
          <span class="period-dash">–</span>
          <div class="field">
            <span>Конец</span>
            <div class="rw-dm">${dmSelectHtml(`period-end-${p.id}`, p.end)}</div>
          </div>
        </div>
        <button type="button" class="btn-danger delete-period" data-id="${p.id}">Удалить</button>
      </div>`;
  });
  container.innerHTML = html;
}

function renderPricingTable() {
  const container = $("pricing-editor");
  if (!container || !currentPricing) return;

  const cats = currentPricing.categories || [];
  const periods = currentPricing.periods || [];
  const periodById = {};
  periods.forEach((p) => {
    periodById[p.id] = p;
  });
  const pids = periodIds();

  if (!cats.length || !pids.length) {
    container.innerHTML = '<span class="status">Нет данных о ценах.</span>';
    return;
  }

  let html = '<table class="pricing-table"><thead><tr><th>Категория</th><th>Тип</th>';
  pids.forEach((pid) => {
    const p = periodById[pid];
    html += `<th>${p ? formatPeriodLabel(p) : pid}</th>`;
  });
  html += "</tr></thead><tbody>";

  cats.forEach((c) => {
    const catPrices = currentPricing.prices[c.id] || {};
    const types = c.allow_extra_beds ? ["adult", "child", "extra_bed"] : ["adult", "child"];
    types.forEach((type, idx) => {
      const prices = catPrices[type] || {};
      html += `<tr>`;
      if (idx === 0) {
        html += `<td class="category-cell" rowspan="${types.length}">${c.label || c.id}</td>`;
      }
      html += `<td class="type-cell">${TYPE_LABELS[type] || type}</td>`;
      pids.forEach((pid) => {
        const value = prices[pid] != null ? prices[pid] : 0;
        const inputId = `price-${c.id}-${type}-${pid}`;
        html += `<td><input type="number" id="${inputId}" value="${value}" min="0" class="price-input" /></td>`;
      });
      html += `</tr>`;
    });
  });

  html += "</tbody></table>";
  container.innerHTML = html;
}

function renderAll() {
  reconcilePrices();
  renderMealPrice();
  renderPeriodsEditor();
  renderCategoriesEditor();
  renderPricingTable();
}

/* ---- Mutations ------------------------------------------------------------ */
function addCategory() {
  if (!currentPricing) return;
  syncFromInputs();
  const id = "cat_" + Date.now().toString(36);
  currentPricing.categories.push({
    id: id,
    label: "Новая категория",
    room_sizes: [2],
    allow_extra_beds: false,
    disabled_discount: 0,
  });
  renderAll();
  scheduleSave(200);
}

function addPeriod() {
  if (!currentPricing) return;
  syncFromInputs();
  if (!currentPricing.periods) currentPricing.periods = [];
  const id = "period_" + Date.now().toString(36);
  currentPricing.periods.push({ id: id, start: "06-01", end: "06-07" });
  renderAll();
  scheduleSave(200);
}

function deletePeriod(id) {
  if (!currentPricing) return;
  if ((currentPricing.periods || []).length <= 1) {
    const status = $("pricing-status");
    if (status) status.textContent = "Должен остаться хотя бы один период.";
    return;
  }
  if (!confirm("Удалить этот период? Цены за него во всех категориях будут удалены.")) return;
  syncFromInputs();
  currentPricing.periods = currentPricing.periods.filter((p) => p.id !== id);
  renderAll();
  scheduleSave(200);
}

function deleteCategory(id) {
  if (!currentPricing) return;
  const cat = findCategory(id);
  if (!confirm(`Удалить категорию «${(cat && cat.label) || id}»? Её цены будут удалены.`)) return;
  syncFromInputs();
  currentPricing.categories = currentPricing.categories.filter((c) => c.id !== id);
  delete currentPricing.prices[id];
  renderAll();
  scheduleSave(200);
}

/* ---- Load / save ---------------------------------------------------------- */
async function loadPricing() {
  const status = $("pricing-status");
  if (status) status.textContent = "Загрузка…";
  try {
    const res = await fetch("/api/admin/prices");
    const data = await res.json();
    if (!res.ok) {
      const msg = (data && data.detail && data.detail.message) || data.detail || "Не удалось загрузить цены";
      if (status) status.textContent = msg;
      return;
    }
    currentPricing = data;
    if (!currentPricing.categories) currentPricing.categories = [];
    renderAll();
    if (status) status.textContent = "Загружено";
  } catch (err) {
    console.error(err);
    if (status) status.textContent = "Не удалось загрузить цены";
  }
}

// Validate the in-memory config. Returns an error string, or null if OK.
function validateConfig() {
  const periods = currentPricing.periods || [];
  if (!periods.length) return "Добавьте хотя бы один период.";
  for (const p of periods) {
    if (!p.start || !p.end) return "У каждого периода должны быть заданы обе даты.";
    if (p.start > p.end) return `Период ${formatPeriodLabel(p)}: начало позже конца.`;
  }
  const pidList = periods.map((p) => p.id);
  if (new Set(pidList).size !== pidList.length) return "Дублирующиеся id периодов.";
  const mealV = Number((currentPricing.constants || {}).meal_price);
  if (!Number.isFinite(mealV) || mealV < 0) return "Некорректная цена питания.";
  for (const c of currentPricing.categories) {
    if (!c.label || !c.label.trim()) return "У каждой категории должно быть название.";
    if (!c.room_sizes || !c.room_sizes.length) return `У категории «${c.label}» не выбрана вместимость.`;
  }
  const ids = currentPricing.categories.map((c) => c.id);
  if (new Set(ids).size !== ids.length) return "Дублирующиеся id категорий.";
  return null;
}

// Persist the current config (autosave). No confirm, no button.
let _saving = false;
let _saveAgain = false;
async function doSave() {
  const status = $("pricing-status");
  if (!currentPricing) return;
  syncFromInputs();
  reconcilePrices();

  const err = validateConfig();
  if (err) { if (status) status.textContent = err; return; }

  if (_saving) { _saveAgain = true; return; } // coalesce overlapping saves
  _saving = true;
  const payload = JSON.parse(JSON.stringify(currentPricing));
  if (status) status.textContent = "Сохранение…";
  try {
    const res = await fetch("/api/admin/prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (status) {
      status.textContent = res.ok
        ? "Сохранено"
        : ((data && data.detail && data.detail.message) || "Не удалось сохранить");
    }
  } catch (err2) {
    console.error(err2);
    if (status) status.textContent = "Не удалось сохранить";
  } finally {
    _saving = false;
    if (_saveAgain) { _saveAgain = false; doSave(); }
  }
}

// Debounced autosave — used for typed inputs (price, meal price, labels).
let _saveTimer = null;
function scheduleSave(delay) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(doSave, delay == null ? 600 : delay);
}

document.addEventListener("DOMContentLoaded", () => {
  const reloadBtn = $("reload-pricing");
  const addBtn = $("add-category");
  const addPeriodBtn = $("add-period");
  const catsContainer = $("categories-editor");
  const periodsContainer = $("periods-editor");
  const pricingContainer = $("pricing-editor");
  const mealEl = $("meal-price");

  if (reloadBtn) reloadBtn.addEventListener("click", loadPricing);
  if (addBtn) addBtn.addEventListener("click", addCategory);
  if (addPeriodBtn) addPeriodBtn.addEventListener("click", addPeriod);

  // --- Autosave (debounced for typed values) ---
  if (pricingContainer) {
    pricingContainer.addEventListener("input", () => scheduleSave());
  }
  if (mealEl) mealEl.addEventListener("input", () => scheduleSave());

  if (periodsContainer) {
    periodsContainer.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".delete-period");
      if (btn) deletePeriod(btn.getAttribute("data-id"));
    });
    // Changing a day/month select shifts a range → re-sort the table immediately,
    // then save (chronological order, requirement #3).
    periodsContainer.addEventListener("change", (e) => {
      if (e.target && (e.target.classList.contains("rw-dm-day") || e.target.classList.contains("rw-dm-mon"))) {
        syncFromInputs();
        renderAll();
        scheduleSave(150);
      }
    });
  }

  if (catsContainer) {
    catsContainer.addEventListener("change", (e) => {
      // Toggling "allow extra beds" restructures the price table → re-render.
      if (e.target && e.target.id && e.target.id.indexOf("cat-extra-") === 0) {
        syncFromInputs();
        renderAll();
      }
      scheduleSave(200); // capacity checkboxes / extra toggle
    });
    catsContainer.addEventListener("input", (e) => {
      // Category label / disabled-discount typing → debounced save.
      scheduleSave();
    });
    catsContainer.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".delete-category");
      if (btn) deleteCategory(btn.getAttribute("data-id"));
    });
  }

  loadPricing();
});
