/*
 * Roomwise history screen: lazy-loaded, newest-first list grouped by creation
 * day (with per-day counters), date-range filter, accordion detail with the
 * per-segment breakdown, swipe-to-delete, and "load into calculator".
 * Reads everything from IndexedDB (window.HistoryDB) — fully offline.
 */
(function () {
  const PAGE_SIZE = 20;
  const SWIPE_THRESHOLD = 90; // px to trigger delete

  const listEl = document.getElementById("history-list");
  const emptyEl = document.getElementById("history-empty");
  const statusEl = document.getElementById("history-status");
  const sentinel = document.getElementById("history-sentinel");

  // Mode: "all" = paginated; "filtered" = fixed date-range result set.
  let mode = "all";
  let lastKey = null;       // createdAt of last loaded item (pagination cursor)
  let exhausted = false;
  let loading = false;
  const dayGroups = {};     // dayStr -> { container, listEl, countEl }

  /* ---------- formatting helpers ---------- */
  function money(n) {
    if (n == null || isNaN(n)) return "–";
    return Number(n).toLocaleString("ru-RU");
  }
  function ddmm(iso) {
    if (!iso) return "";
    const parts = iso.split("-");
    return parts.length === 3 ? parts[2] + "." + parts[1] : iso;
  }
  function dayLabel(dayStr) {
    const today = window.HistoryDB.localDay(Date.now());
    const yesterday = window.HistoryDB.localDay(Date.now() - 86400000);
    if (dayStr === today) return "Сегодня";
    if (dayStr === yesterday) return "Вчера";
    const d = new Date(dayStr + "T00:00:00");
    const opts = { day: "numeric", month: "long" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("ru-RU", opts);
  }
  function nightsWord(n) {
    const a = Math.abs(n) % 100;
    const b = n % 10;
    if (a > 10 && a < 20) return "дней";
    if (b > 1 && b < 5) return "дня";
    if (b === 1) return "день";
    return "дней";
  }

  /* ---------- day groups ---------- */
  async function ensureDayGroup(dayStr) {
    if (dayGroups[dayStr]) return dayGroups[dayStr];

    const container = document.createElement("section");
    container.className = "history-day";
    container.dataset.day = dayStr;

    const header = document.createElement("div");
    header.className = "history-day-header";
    const title = document.createElement("span");
    title.className = "history-day-title";
    title.textContent = dayLabel(dayStr);
    const countEl = document.createElement("span");
    countEl.className = "history-day-count";
    header.appendChild(title);
    header.appendChild(countEl);

    const groupList = document.createElement("div");
    groupList.className = "history-day-list";

    container.appendChild(header);
    container.appendChild(groupList);
    listEl.appendChild(container);

    const group = { container: container, listEl: groupList, countEl: countEl };
    dayGroups[dayStr] = group;
    await refreshDayCount(dayStr);
    return group;
  }

  async function refreshDayCount(dayStr) {
    const group = dayGroups[dayStr];
    if (!group) return;
    const count = await window.HistoryDB.countByDay(dayStr);
    group.countEl.textContent = count + " " + (count === 1 ? "расчёт" : "расч.");
  }

  function removeDayGroupIfEmpty(dayStr) {
    const group = dayGroups[dayStr];
    if (group && group.listEl.children.length === 0) {
      group.container.remove();
      delete dayGroups[dayStr];
    }
  }

  /* ---------- card rendering ---------- */
  function createCard(rec) {
    const card = document.createElement("div");
    card.className = "history-card";
    card.dataset.id = rec.id;

    const inner = document.createElement("div");
    inner.className = "history-card-inner";

    // Compact summary (always visible)
    const summary = document.createElement("div");
    summary.className = "history-card-summary";
    const req = rec.request || {};
    const stay = ddmm(req.check_in) + "–" + ddmm(req.check_out);
    summary.innerHTML =
      '<div class="hc-main">' +
        '<span class="hc-category">' + (rec.categoryLabel || req.category || "") + "</span>" +
        '<span class="hc-stay">' + stay + "</span>" +
      "</div>" +
      '<div class="hc-meta">' +
        '<span class="hc-nights">' + (rec.nights || 0) + " " + nightsWord(rec.nights || 0) + "</span>" +
        '<span class="hc-total">' + money(rec.total_after_discount != null ? rec.total_after_discount : rec.total) + "</span>" +
      "</div>";

    // Detail (accordion, hidden by default)
    const detail = document.createElement("div");
    detail.className = "history-card-detail";
    detail.style.display = "none";
    detail.appendChild(buildDetail(rec));

    summary.addEventListener("click", function () {
      detail.style.display = detail.style.display === "none" ? "block" : "none";
    });

    inner.appendChild(summary);
    inner.appendChild(detail);
    card.appendChild(inner);

    attachSwipe(card, inner, rec);
    return card;
  }

  function buildDetail(rec) {
    const wrap = document.createElement("div");
    const req = rec.request || {};
    const cap = req.room_size != null ? req.room_size + "м" : "";

    const rows = (rec.breakdown || []).map(function (seg) {
      return (
        '<div class="hd-row">' +
          '<span>' + ddmm(seg.start) + "–" + ddmm(seg.end) + "</span>" +
          '<span>' + (rec.categoryLabel || req.category || "") + "</span>" +
          '<span>' + cap + "</span>" +
          '<span>' + money(seg.per_night) + "/ночь</span>" +
          '<span>' + money(seg.total) + "</span>" +
        "</div>"
      );
    }).join("");

    wrap.innerHTML =
      '<div class="hd-table">' +
        '<div class="hd-row hd-head"><span>Дата</span><span>Категория</span><span>Вмест.</span><span>Цена/день</span><span>Сумма</span></div>' +
        rows +
      "</div>" +
      '<div class="hd-totals">' +
        "Итого: " + money(rec.total) +
        (rec.total_after_discount != null && rec.total_after_discount !== rec.total
          ? " · Со скидкой: " + money(rec.total_after_discount) : "") +
        " · Предоплата: " + money(rec.prepayment_amount) +
      "</div>" +
      '<div class="hd-actions">' +
        '<button type="button" class="btn-load">Загрузить в калькулятор</button>' +
        '<button type="button" class="btn-danger btn-del">Удалить</button>' +
      "</div>";

    wrap.querySelector(".btn-load").addEventListener("click", function (e) {
      e.stopPropagation();
      loadIntoCalculator(rec);
    });
    wrap.querySelector(".btn-del").addEventListener("click", function (e) {
      e.stopPropagation();
      deleteRecord(rec);
    });
    return wrap;
  }

  /* ---------- actions ---------- */
  function loadIntoCalculator(rec) {
    try {
      sessionStorage.setItem("turanParsedBooking", JSON.stringify(rec.request || {}));
    } catch (e) { /* ignore */ }
    window.location.href = "index.html";
  }

  async function deleteRecord(rec) {
    const card = listEl.querySelector('.history-card[data-id="' + rec.id + '"]');
    try {
      await window.HistoryDB.deleteCalculation(rec.id);
    } catch (e) { console.error(e); return; }
    const dayStr = window.HistoryDB.localDay(rec.createdAt);
    if (card) card.remove();
    await refreshDayCount(dayStr);
    removeDayGroupIfEmpty(dayStr);
    checkEmpty();
  }

  /* ---------- swipe-to-delete (touch) ---------- */
  function attachSwipe(card, inner, rec) {
    let startX = 0, dx = 0, active = false;
    inner.addEventListener("touchstart", function (e) {
      startX = e.touches[0].clientX; dx = 0; active = true;
      inner.style.transition = "none";
    }, { passive: true });
    inner.addEventListener("touchmove", function (e) {
      if (!active) return;
      dx = e.touches[0].clientX - startX;
      if (dx > 0) dx = 0; // left only
      inner.style.transform = "translateX(" + dx + "px)";
    }, { passive: true });
    inner.addEventListener("touchend", function () {
      if (!active) return;
      active = false;
      inner.style.transition = "transform 0.2s ease";
      if (Math.abs(dx) > SWIPE_THRESHOLD) {
        inner.style.transform = "translateX(-100%)";
        deleteRecord(rec);
      } else {
        inner.style.transform = "translateX(0)";
      }
    });
  }

  /* ---------- list building ---------- */
  async function appendRecords(records) {
    for (const rec of records) {
      const dayStr = rec.createdDay || window.HistoryDB.localDay(rec.createdAt);
      const group = await ensureDayGroup(dayStr);
      group.listEl.appendChild(createCard(rec));
    }
  }

  function clearList() {
    listEl.innerHTML = "";
    for (const k in dayGroups) delete dayGroups[k];
  }

  function checkEmpty() {
    const hasCards = listEl.querySelector(".history-card");
    emptyEl.style.display = hasCards ? "none" : "block";
  }

  async function loadNextPage() {
    if (mode !== "all" || loading || exhausted) return;
    loading = true;
    statusEl.textContent = "Загрузка…";
    try {
      const records = await window.HistoryDB.queryPage(lastKey, PAGE_SIZE);
      if (!records.length) {
        exhausted = true;
      } else {
        await appendRecords(records);
        lastKey = records[records.length - 1].createdAt;
        if (records.length < PAGE_SIZE) exhausted = true;
      }
    } catch (e) {
      console.error(e);
    } finally {
      loading = false;
      statusEl.textContent = exhausted ? "" : "";
      checkEmpty();
    }
  }

  /* ---------- filtering ---------- */
  async function applyFilter() {
    const fromStr = document.getElementById("filter-from").value;
    const toStr = document.getElementById("filter-to").value;
    if (!fromStr && !toStr) { resetFilter(); return; }
    const fromMs = fromStr ? new Date(fromStr + "T00:00:00").getTime() : 0;
    const toMs = toStr ? new Date(toStr + "T23:59:59.999").getTime() : Date.now() + 86400000;

    mode = "filtered";
    clearList();
    statusEl.textContent = "Загрузка…";
    try {
      const records = await window.HistoryDB.queryByDateRange(fromMs, toMs);
      await appendRecords(records);
    } catch (e) {
      console.error(e);
    }
    statusEl.textContent = "";
    checkEmpty();
  }

  function resetFilter() {
    document.getElementById("filter-from").value = "";
    document.getElementById("filter-to").value = "";
    mode = "all";
    lastKey = null;
    exhausted = false;
    clearList();
    loadNextPage();
  }

  /* ---------- init ---------- */
  function initObserver() {
    if (!("IntersectionObserver" in window)) return;
    const obs = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) loadNextPage();
    }, { rootMargin: "200px" });
    obs.observe(sentinel);
  }

  document.addEventListener("DOMContentLoaded", function () {
    const filterToggle = document.getElementById("filter-toggle");
    const filterPanel = document.getElementById("filter-panel");
    if (filterToggle && filterPanel) {
      filterToggle.addEventListener("click", function () {
        filterPanel.style.display = filterPanel.style.display === "none" ? "block" : "none";
      });
    }
    const applyBtn = document.getElementById("filter-apply");
    const resetBtn = document.getElementById("filter-reset");
    if (applyBtn) applyBtn.addEventListener("click", applyFilter);
    if (resetBtn) resetBtn.addEventListener("click", resetFilter);

    loadNextPage();
    initObserver();
  });
})();
