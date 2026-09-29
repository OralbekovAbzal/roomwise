/*
 * pricing-engine.js — client-side port of pricing.py (PricingEngine).
 * Runs entirely on-device so the app needs no Python server.
 * Behaviour (numbers and result_text) is kept identical to the server engine.
 * Exposes: window.PricingEngine, window.PricingError.
 */
(function () {
  "use strict";

  function PricingError(message) {
    this.name = "PricingError";
    this.message = message;
  }
  PricingError.prototype = Object.create(Error.prototype);
  PricingError.prototype.constructor = PricingError;

  // ---- Date helpers (UTC midnight to avoid timezone drift) ----
  function parseISO(s) {
    // s = "YYYY-MM-DD"
    return new Date(s + "T00:00:00Z");
  }
  function addDays(d, n) {
    return new Date(d.getTime() + n * 86400000);
  }
  function diffDays(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }
  function mmOf(d) { return d.getUTCMonth() + 1; }
  function ddOf(d) { return d.getUTCDate(); }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function ddmm(d) { return pad2(ddOf(d)) + "." + pad2(mmOf(d)); }
  function isoOf(d) {
    return d.getUTCFullYear() + "-" + pad2(mmOf(d)) + "-" + pad2(ddOf(d));
  }

  // Round half to even (matches Python's round()).
  function roundHalfEven(x) {
    const r = Math.round(x);
    if (Math.abs(x - Math.trunc(x)) === 0.5) {
      // exactly .5 -> round to even
      const floor = Math.floor(x);
      return floor % 2 === 0 ? floor : floor + 1;
    }
    return r;
  }

  const LEGACY_DEFAULTS = {
    econom: { sizes: [2, 3, 4], extra: false, dis: 2000, label: "Эконом" },
    standard: { sizes: [2, 3, 4, 5], extra: false, dis: 3000, label: "Стандарт" },
    comfort: { sizes: [2, 3], extra: true, dis: 3000, label: "Комфорт" },
  };

  function PricingEngine(config) {
    if (!config || typeof config !== "object") {
      throw new PricingError("Пустой конфиг цен.");
    }
    this.constants = config.constants || {};
    this.periodsRaw = config.periods || [];
    this.prices = config.prices || {};

    if (!Array.isArray(this.periodsRaw) || !this.periodsRaw.length) {
      throw new PricingError("В данных цен отсутствуют периоды.");
    }
    if (!this.prices || typeof this.prices !== "object") {
      throw new PricingError("В данных цен отсутствует ключ: prices");
    }

    // Meal price (with legacy fallback).
    const c = this.constants;
    this.mealPrice = parseInt(
      c.meal_price != null ? c.meal_price : (c.no_meal_discount != null ? c.no_meal_discount : 0),
      10
    ) || 0;

    // Parse periods to {id, startMMDD:[m,d], endMMDD:[m,d]}
    this.periods = this.periodsRaw.map(function (p) {
      const s = String(p.start).split("-").map(Number);
      const e = String(p.end).split("-").map(Number);
      return { id: p.id, start: [s[0], s[1]], end: [e[0], e[1]] };
    });
    const periodIds = this.periodsRaw.map(function (p) { return p.id; });

    // Categories (data, not code) — migrate if absent.
    this.categoriesRaw = (config.categories && config.categories.length)
      ? config.categories
      : this._defaultCategories();

    this.categories = {};
    const self = this;
    this.categoriesRaw.forEach(function (cc) {
      let cat;
      try {
        const id = String(cc.id);
        const sizes = new Set((cc.room_sizes || []).map(function (x) { return parseInt(x, 10); }));
        cat = {
          id: id,
          label: String(cc.label || id),
          room_sizes: sizes,
          allow_extra_beds: !!cc.allow_extra_beds,
          disabled_discount: parseInt(cc.disabled_discount, 10) || 0,
        };
      } catch (e) {
        throw new PricingError("Некорректное описание категории.");
      }
      if (!cat.room_sizes.size) {
        throw new PricingError("У категории «" + cat.label + "» не задана вместимость.");
      }
      self.categories[cat.id] = cat;
      self._validateCategoryPrices(cat, periodIds);
    });
  }

  PricingEngine.prototype._defaultCategories = function () {
    const result = [];
    const prices = this.prices;
    Object.keys(prices).forEach(function (id) {
      const d = LEGACY_DEFAULTS[id];
      if (d) {
        result.push({ id: id, label: d.label, room_sizes: d.sizes, allow_extra_beds: d.extra, disabled_discount: d.dis });
      } else {
        const hasExtra = !!(prices[id] && prices[id].extra_bed);
        result.push({ id: id, label: id, room_sizes: [2, 3, 4], allow_extra_beds: hasExtra, disabled_discount: 3000 });
      }
    });
    return result;
  };

  PricingEngine.prototype._validateCategoryPrices = function (cat, periodIds) {
    const cp = this.prices[cat.id];
    if (!cp || typeof cp !== "object") {
      throw new PricingError("Нет цен для категории «" + cat.label + "».");
    }
    const types = cat.allow_extra_beds ? ["adult", "child", "extra_bed"] : ["adult", "child"];
    types.forEach(function (t) {
      const tp = cp[t];
      if (!tp || typeof tp !== "object") {
        throw new PricingError("У категории «" + cat.label + "» нет цен типа «" + t + "».");
      }
      periodIds.forEach(function (pid) {
        if (!(pid in tp)) {
          throw new PricingError("У категории «" + cat.label + "» нет цены «" + t + "» для периода " + pid + ".");
        }
      });
    });
  };

  // ---- categories metadata for /api/categories ----
  PricingEngine.prototype.categoriesMeta = function () {
    const self = this;
    return this.categoriesRaw.map(function (cc) {
      const cat = self.categories[String(cc.id)];
      return {
        id: cat.id,
        label: cat.label,
        room_sizes: Array.from(cat.room_sizes).sort(function (a, b) { return a - b; }),
        allow_extra_beds: cat.allow_extra_beds,
      };
    });
  };

  // ---- input normalization (mirrors models.CalcRequest defaults) ----
  function normalizeReq(raw) {
    const r = Object.assign({
      extra_bed_count: 0, extra_bed_meal: 0, extra_bed_no_meal: 0,
      adults_meal: 0, children_meal: 0, adults_no_meal: 0, children_no_meal: 0,
      has_disabled: false, disabled_adults: 0, disabled_children: 0,
      discount_percent: 0, prepayment_percent: 50,
    }, raw || {});
    ["room_size", "extra_bed_count", "extra_bed_meal", "extra_bed_no_meal",
     "adults_meal", "children_meal", "adults_no_meal", "children_no_meal",
     "disabled_adults", "disabled_children", "discount_percent", "prepayment_percent"
    ].forEach(function (k) { r[k] = parseInt(r[k], 10) || 0; });
    r.has_disabled = !!r.has_disabled;
    if (r.extra_bed_meal === 0 && r.extra_bed_no_meal === 0 && r.extra_bed_count > 0) {
      r.extra_bed_meal = r.extra_bed_count;
    }
    return r;
  }

  // ---- helpers ----
  PricingEngine.prototype._getPeriodForDate = function (d) {
    const m = mmOf(d), day = ddOf(d);
    for (let i = 0; i < this.periods.length; i++) {
      const p = this.periods[i];
      const afterStart = (m > p.start[0]) || (m === p.start[0] && day >= p.start[1]);
      const beforeEnd = (m < p.end[0]) || (m === p.end[0] && day <= p.end[1]);
      if (afterStart && beforeEnd) return p.id;
    }
    return null;
  };

  PricingEngine.prototype._buildSegments = function (checkIn, checkOut) {
    const days = [];
    let current = checkIn;
    while (current.getTime() < checkOut.getTime()) {
      const pid = this._getPeriodForDate(current);
      if (pid === null) {
        throw new PricingError("Для даты " + isoOf(current) + " не задан ценовой период.");
      }
      days.push({ date: current, pid: pid });
      current = addDays(current, 1);
    }
    if (!days.length) return [];

    const segments = [];
    let segStart = days[0].date;
    let curPeriod = days[0].pid;
    for (let i = 1; i < days.length; i++) {
      if (days[i].pid !== curPeriod) {
        segments.push({ start: segStart, end: days[i].date, nights: diffDays(segStart, days[i].date), period_id: curPeriod });
        segStart = days[i].date;
        curPeriod = days[i].pid;
      }
    }
    segments.push({ start: segStart, end: checkOut, nights: diffDays(segStart, checkOut), period_id: curPeriod });
    return segments;
  };

  PricingEngine.prototype._distributeDisabled = function (req) {
    if (!req.has_disabled) return [0, 0, 0, 0];
    const daMeal = Math.min(req.disabled_adults, req.adults_meal);
    const remA = req.disabled_adults - daMeal;
    const daNoMeal = Math.max(Math.min(remA, req.adults_no_meal), 0);
    const dcMeal = Math.min(req.disabled_children, req.children_meal);
    const remC = req.disabled_children - dcMeal;
    const dcNoMeal = Math.max(Math.min(remC, req.children_no_meal), 0);
    return [daMeal, daNoMeal, dcMeal, dcNoMeal];
  };

  PricingEngine.prototype._validateBasic = function (req) {
    const checkIn = parseISO(req.check_in);
    const checkOut = parseISO(req.check_out);
    if (checkOut.getTime() <= checkIn.getTime()) {
      throw new PricingError("Дата выезда должна быть позже даты заезда.");
    }
    const cat = this.categories[req.category];
    if (!cat) throw new PricingError("Неизвестная категория: " + req.category + ".");
    if (!cat.room_sizes.has(req.room_size)) {
      const allowed = Array.from(cat.room_sizes).sort(function (a, b) { return a - b; }).join(", ");
      throw new PricingError("Недопустимая вместимость для категории «" + cat.label + "». Допустимые значения: " + allowed + ".");
    }
    const totalPeople = req.adults_meal + req.children_meal + req.adults_no_meal + req.children_no_meal;
    if (totalPeople <= 0) throw new PricingError("Укажите хотя бы одного гостя.");

    const extraBedTotal = req.extra_bed_meal + req.extra_bed_no_meal;
    let capacity = req.room_size;
    if (cat.allow_extra_beds) capacity += extraBedTotal;
    if (totalPeople > capacity) {
      throw new PricingError("Число гостей (" + totalPeople + ") превышает вместимость (" + capacity + ").");
    }
    if (!cat.allow_extra_beds && extraBedTotal > 0) {
      throw new PricingError("Доп. места не разрешены для категории «" + cat.label + "».");
    }
    if (req.has_disabled) {
      if (req.disabled_adults > (req.adults_meal + req.adults_no_meal)) {
        throw new PricingError("Взрослых с ОВ не может быть больше общего числа взрослых.");
      }
      if (req.disabled_children > (req.children_meal + req.children_no_meal)) {
        throw new PricingError("Детей с ОВ не может быть больше общего числа детей.");
      }
    }
  };

  // ---- main ----
  PricingEngine.prototype.calculate = function (rawReq) {
    const req = normalizeReq(rawReq);
    this._validateBasic(req);

    const checkIn = parseISO(req.check_in);
    const checkOut = parseISO(req.check_out);
    const segments = this._buildSegments(checkIn, checkOut);
    if (!segments.length) throw new PricingError("В брони нет ночей.");

    const dd = this._distributeDisabled(req);
    const daMeal = dd[0], daNoMeal = dd[1], dcMeal = dd[2], dcNoMeal = dd[3];

    const lines = [];
    let grandTotal = 0;
    const breakdown = [];

    const cat = this.categories[req.category];
    const categoryLabel = cat.label;
    const meal = this.mealPrice;

    lines.push(req.room_size + "x " + categoryLabel);

    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      const nights = seg.nights;
      const pid = seg.period_id;
      const pAdult = parseInt(this.prices[req.category]["adult"][pid], 10);
      const pChild = parseInt(this.prices[req.category]["child"][pid], 10);
      let extraBedPrice = null;
      if (cat.allow_extra_beds && this.prices[req.category].extra_bed) {
        extraBedPrice = parseInt(this.prices[req.category]["extra_bed"][pid], 10);
      }
      const dis = cat.disabled_discount;

      lines.push(ddmm(seg.start) + "–" + ddmm(seg.end));

      let segTotal = 0;
      const groups = [];

      // Adults - meal
      const nAdMeal = Math.max(req.adults_meal - daMeal, 0);
      if (nAdMeal > 0) {
        const a = nAdMeal * Math.max(pAdult, 0) * nights;
        segTotal += a;
        groups.push(nAdMeal + " взр. с питанием * " + pAdult + " * " + nights + " = " + a);
      }
      if (daMeal > 0) {
        const a = daMeal * Math.max(pAdult - dis, 0) * nights;
        segTotal += a;
        groups.push(daMeal + " взр. с ОВ с питанием * (" + pAdult + "-" + dis + ") * " + nights + " = " + a);
      }

      // Adults - no meal
      const nAdNoMeal = Math.max(req.adults_no_meal - daNoMeal, 0);
      if (nAdNoMeal > 0) {
        const a = nAdNoMeal * Math.max(pAdult - meal, 0) * nights;
        segTotal += a;
        groups.push(nAdNoMeal + " взр. без питания * (" + pAdult + "-" + meal + ") * " + nights + " = " + a);
      }
      if (daNoMeal > 0) {
        const a = daNoMeal * Math.max(pAdult - meal - dis, 0) * nights;
        segTotal += a;
        groups.push(daNoMeal + " взр. с ОВ без питания * (" + pAdult + "-" + meal + "-" + dis + ") * " + nights + " = " + a);
      }

      // Children - meal
      const nChMeal = Math.max(req.children_meal - dcMeal, 0);
      if (nChMeal > 0) {
        const a = nChMeal * Math.max(pChild, 0) * nights;
        segTotal += a;
        groups.push(nChMeal + " реб. с питанием * " + pChild + " * " + nights + " = " + a);
      }
      if (dcMeal > 0) {
        const a = dcMeal * Math.max(pChild - dis, 0) * nights;
        segTotal += a;
        groups.push(dcMeal + " реб. с ОВ с питанием * (" + pChild + "-" + dis + ") * " + nights + " = " + a);
      }

      // Children - no meal
      const nChNoMeal = Math.max(req.children_no_meal - dcNoMeal, 0);
      if (nChNoMeal > 0) {
        const a = nChNoMeal * Math.max(pChild - meal, 0) * nights;
        segTotal += a;
        groups.push(nChNoMeal + " реб. без питания * (" + pChild + "-" + meal + ") * " + nights + " = " + a);
      }
      if (dcNoMeal > 0) {
        const a = dcNoMeal * Math.max(pChild - meal - dis, 0) * nights;
        segTotal += a;
        groups.push(dcNoMeal + " реб. с ОВ без питания * (" + pChild + "-" + meal + "-" + dis + ") * " + nights + " = " + a);
      }

      // Extra beds
      if (extraBedPrice !== null) {
        if (req.extra_bed_meal > 0) {
          const a = req.extra_bed_meal * extraBedPrice * nights;
          segTotal += a;
          groups.push(req.extra_bed_meal + " доп. кровать с питанием * " + extraBedPrice + " * " + nights + " = " + a);
        }
        if (req.extra_bed_no_meal > 0) {
          const pe = Math.max(extraBedPrice - meal, 0);
          const a = req.extra_bed_no_meal * pe * nights;
          segTotal += a;
          groups.push(req.extra_bed_no_meal + " доп. кровать без питания * (" + extraBedPrice + "-" + meal + ") * " + nights + " = " + a);
        }
      }

      for (let g = 0; g < groups.length; g++) lines.push(groups[g]);

      breakdown.push({
        start: isoOf(seg.start),
        end: isoOf(seg.end),
        nights: nights,
        total: segTotal,
        per_night: nights ? roundHalfEven(segTotal / nights) : 0,
      });

      grandTotal += segTotal;
      lines.push("");
    }

    const discountAmount = roundHalfEven(grandTotal * (req.discount_percent / 100));
    const totalAfterDiscount = roundHalfEven(grandTotal - discountAmount);
    const prepaymentAmount = roundHalfEven(totalAfterDiscount * (req.prepayment_percent / 100));

    lines.push("Итого: " + grandTotal);
    if (req.discount_percent && req.discount_percent > 0) {
      lines.push("Скидка " + req.discount_percent + "%: -" + discountAmount);
      lines.push("Итого со скидкой: " + totalAfterDiscount);
    }
    lines.push("Предоплата " + req.prepayment_percent + "%: " + prepaymentAmount);

    const resultText = lines.join("\n").replace(/\s+$/, "");
    return {
      result_text: resultText,
      total: grandTotal,
      total_after_discount: totalAfterDiscount,
      prepayment_amount: prepaymentAmount,
      breakdown: breakdown,
    };
  };

  window.PricingError = PricingError;
  window.PricingEngine = PricingEngine;
})();
