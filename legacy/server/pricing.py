from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from models import CalcRequest


class PricingError(Exception):
    """Domain-level error for bad input or configuration."""


@dataclass
class PeriodDef:
    id: str
    start_mmdd: Tuple[int, int]
    end_mmdd: Tuple[int, int]


@dataclass
class Segment:
    start: date  # inclusive
    end: date  # exclusive
    nights: int
    period_id: str


@dataclass
class CategoryDef:
    id: str
    label: str
    room_sizes: set  # set[int] of allowed room capacities
    allow_extra_beds: bool
    disabled_discount: int


class PricingEngine:
    def __init__(self, raw_data: Dict):
        try:
            self.constants = raw_data["constants"]
            self.periods_raw = raw_data["periods"]
            self.prices = raw_data["prices"]
        except KeyError as exc:
            raise PricingError(f"В данных цен отсутствует ключ: {exc}") from exc

        # All prices are entered WITH meal. Guests "without meal" get this global
        # price subtracted per night. Source key is `meal_price`; fall back to the
        # legacy `no_meal_discount` for older prices.json files.
        self.meal_price: int = int(
            self.constants.get("meal_price", self.constants.get("no_meal_discount", 0))
        )

        self.periods: List[PeriodDef] = []
        for p in self.periods_raw:
            mm_s, dd_s = map(int, p["start"].split("-"))
            mm_e, dd_e = map(int, p["end"].split("-"))
            self.periods.append(
                PeriodDef(
                    id=p["id"],
                    start_mmdd=(mm_s, dd_s),
                    end_mmdd=(mm_e, dd_e),
                )
            )

        period_ids = [p["id"] for p in self.periods_raw]

        # Categories are data, not code. If the file predates the categories
        # block, synthesize a sensible default from the price keys (migration).
        self.categories_raw = raw_data.get("categories") or self._default_categories()
        self.categories: Dict[str, CategoryDef] = {}
        for c in self.categories_raw:
            try:
                cat_id = str(c["id"])
                room_sizes = {int(x) for x in c["room_sizes"]}
                cat = CategoryDef(
                    id=cat_id,
                    label=str(c.get("label") or cat_id),
                    room_sizes=room_sizes,
                    allow_extra_beds=bool(c.get("allow_extra_beds", False)),
                    disabled_discount=int(c.get("disabled_discount", 0)),
                )
            except (KeyError, ValueError, TypeError) as exc:
                raise PricingError(f"Некорректное описание категории: {exc}") from exc
            if not cat.room_sizes:
                raise PricingError(
                    f"У категории «{cat.label}» не задана вместимость."
                )
            self.categories[cat_id] = cat
            self._validate_category_prices(cat, period_ids)

    def _default_categories(self) -> List[Dict]:
        """Build default category metadata for legacy prices.json without a
        `categories` block, so the engine keeps working until the file is
        re-saved from the new editor."""
        legacy_defaults = {
            "econom": ([2, 3, 4], False, 2000),
            "standard": ([2, 3, 4, 5], False, 3000),
            "comfort": ([2, 3], True, 3000),
        }
        legacy_labels = {"econom": "Эконом", "standard": "Стандарт", "comfort": "Комфорт"}
        result: List[Dict] = []
        for cat_id, cat_prices in self.prices.items():
            room_sizes, allow_extra, disabled = legacy_defaults.get(
                cat_id, ([2, 3, 4], "extra_bed" in (cat_prices or {}), 3000)
            )
            result.append(
                {
                    "id": cat_id,
                    "label": legacy_labels.get(cat_id, cat_id),
                    "room_sizes": room_sizes,
                    "allow_extra_beds": allow_extra,
                    "disabled_discount": disabled,
                }
            )
        return result

    def _validate_category_prices(self, cat: CategoryDef, period_ids: List[str]) -> None:
        """Ensure every category has adult/child (and extra_bed when enabled)
        prices for every period. This doubles as validation for POST."""
        cat_prices = self.prices.get(cat.id)
        if not isinstance(cat_prices, dict):
            raise PricingError(f"Нет цен для категории «{cat.label}».")
        required_types = ["adult", "child"]
        if cat.allow_extra_beds:
            required_types.append("extra_bed")
        for ptype in required_types:
            type_prices = cat_prices.get(ptype)
            if not isinstance(type_prices, dict):
                raise PricingError(
                    f"У категории «{cat.label}» нет цен типа «{ptype}»."
                )
            for pid in period_ids:
                if pid not in type_prices:
                    raise PricingError(
                        f"У категории «{cat.label}» нет цены «{ptype}» для периода {pid}."
                    )

    @classmethod
    def from_file(cls, path: Path) -> "PricingEngine":
        import json

        if not path.exists():
            raise FileNotFoundError(f"prices.json not found at {path}")
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return cls(data)

    # ---- Public API -----------------------------------------------------
    def calculate(self, req: CalcRequest) -> Tuple[str, int, int, int, List[Dict]]:
        self._validate_basic(req)
        segments = self._build_segments(req.check_in, req.check_out)
        if not segments:
            raise PricingError("В брони нет ночей.")

        (
            da_meal,
            da_no_meal,
            dc_meal,
            dc_no_meal,
        ) = self._distribute_disabled(req)

        total_people = (
            req.adults_meal
            + req.children_meal
            + req.adults_no_meal
            + req.children_no_meal
        )

        lines: List[str] = []
        grand_total = 0
        breakdown: List[Dict] = []  # structured per-segment detail for history

        cat = self.categories[req.category]
        category_label = cat.label

        # Room size + category printed once at the top (segments only differ by
        # date range / price period, not by room or category).
        lines.append(f"{req.room_size}x {category_label}")

        for seg in segments:
            nights = seg.nights
            period_id = seg.period_id

            p_adult = int(self.prices[req.category]["adult"][period_id])
            p_child = int(self.prices[req.category]["child"][period_id])

            extra_bed_price: Optional[int] = None
            if cat.allow_extra_beds and "extra_bed" in self.prices[req.category]:
                extra_bed_price = int(self.prices[req.category]["extra_bed"][period_id])

            dis = cat.disabled_discount

            # Date range header for this segment
            seg_start_str = seg.start.strftime("%d.%m")
            seg_end_str = seg.end.strftime("%d.%m")
            lines.append(f"{seg_start_str}–{seg_end_str}")

            segment_total = 0

            groups: List[Tuple[int, str, int]] = []

            # Adults - meal
            normal_adults_meal = max(req.adults_meal - da_meal, 0)
            disabled_adults_meal = da_meal

            price_adult_meal_normal = max(p_adult, 0)
            price_adult_meal_disabled = max(p_adult - dis, 0)

            if normal_adults_meal > 0:
                amount = normal_adults_meal * price_adult_meal_normal * nights
                segment_total += amount
                groups.append(
                    (
                        amount,
                        f"{normal_adults_meal} взр. с питанием * {p_adult} * {nights} = {amount}",
                        normal_adults_meal,
                    )
                )

            if disabled_adults_meal > 0:
                amount = disabled_adults_meal * price_adult_meal_disabled * nights
                segment_total += amount
                groups.append(
                    (
                        amount,
                        f"{disabled_adults_meal} взр. с ОВ с питанием * ({p_adult}-{dis}) * {nights} = {amount}",
                        disabled_adults_meal,
                    )
                )

            # Adults - no meal
            normal_adults_no_meal = max(req.adults_no_meal - da_no_meal, 0)
            disabled_adults_no_meal = da_no_meal

            price_adult_nm_normal = max(p_adult - self.meal_price, 0)
            price_adult_nm_disabled = max(p_adult - self.meal_price - dis, 0)

            if normal_adults_no_meal > 0:
                amount = normal_adults_no_meal * price_adult_nm_normal * nights
                segment_total += amount
                groups.append(
                    (
                        amount,
                        f"{normal_adults_no_meal} взр. без питания * ({p_adult}-{self.meal_price}) * {nights} = {amount}",
                        normal_adults_no_meal,
                    )
                )

            if disabled_adults_no_meal > 0:
                amount = disabled_adults_no_meal * price_adult_nm_disabled * nights
                segment_total += amount
                groups.append(
                    (
                        amount,
                        f"{disabled_adults_no_meal} взр. с ОВ без питания * ({p_adult}-{self.meal_price}-{dis}) * {nights} = {amount}",
                        disabled_adults_no_meal,
                    )
                )

            # Children - meal
            normal_children_meal = max(req.children_meal - dc_meal, 0)
            disabled_children_meal = dc_meal

            price_child_meal_normal = max(p_child, 0)
            price_child_meal_disabled = max(p_child - dis, 0)

            if normal_children_meal > 0:
                amount = normal_children_meal * price_child_meal_normal * nights
                segment_total += amount
                groups.append(
                    (
                        amount,
                        f"{normal_children_meal} реб. с питанием * {p_child} * {nights} = {amount}",
                        normal_children_meal,
                    )
                )

            if disabled_children_meal > 0:
                amount = disabled_children_meal * price_child_meal_disabled * nights
                segment_total += amount
                groups.append(
                    (
                        amount,
                        f"{disabled_children_meal} реб. с ОВ с питанием * ({p_child}-{dis}) * {nights} = {amount}",
                        disabled_children_meal,
                    )
                )

            # Children - no meal
            normal_children_no_meal = max(req.children_no_meal - dc_no_meal, 0)
            disabled_children_no_meal = dc_no_meal

            price_child_nm_normal = max(p_child - self.meal_price, 0)
            price_child_nm_disabled = max(p_child - self.meal_price - dis, 0)

            if normal_children_no_meal > 0:
                amount = normal_children_no_meal * price_child_nm_normal * nights
                segment_total += amount
                groups.append(
                    (
                        amount,
                        f"{normal_children_no_meal} реб. без питания * ({p_child}-{self.meal_price}) * {nights} = {amount}",
                        normal_children_no_meal,
                    )
                )

            if disabled_children_no_meal > 0:
                amount = disabled_children_no_meal * price_child_nm_disabled * nights
                segment_total += amount
                groups.append(
                    (
                        amount,
                        f"{disabled_children_no_meal} реб. с ОВ без питания * ({p_child}-{self.meal_price}-{dis}) * {nights} = {amount}",
                        disabled_children_no_meal,
                    )
                )

            # Extra bed — с питанием и без питания
            if extra_bed_price is not None:
                if req.extra_bed_meal > 0:
                    extra_amount = req.extra_bed_meal * extra_bed_price * nights
                    segment_total += extra_amount
                    groups.append(
                        (
                            extra_amount,
                            f"{req.extra_bed_meal} доп. кровать с питанием * {extra_bed_price} * {nights} = {extra_amount}",
                            req.extra_bed_meal,
                        )
                    )
                price_extra_no_meal = max(extra_bed_price - self.meal_price, 0)
                if req.extra_bed_no_meal > 0:
                    extra_nm_amount = req.extra_bed_no_meal * price_extra_no_meal * nights
                    segment_total += extra_nm_amount
                    groups.append(
                        (
                            extra_nm_amount,
                            f"{req.extra_bed_no_meal} доп. кровать без питания * ({extra_bed_price}-{self.meal_price}) * {nights} = {extra_nm_amount}",
                            req.extra_bed_no_meal,
                        )
                    )

            # Only non-zero groups are added; already ensured above.
            for _amount, text, _count in groups:
                lines.append(text)

            breakdown.append(
                {
                    "start": seg.start.isoformat(),
                    "end": seg.end.isoformat(),
                    "nights": nights,
                    "total": segment_total,
                    "per_night": int(round(segment_total / nights)) if nights else 0,
                }
            )

            grand_total += segment_total
            lines.append("")  # blank line between segments

        discount_amount = round(grand_total * (req.discount_percent / 100))
        total_after_discount = int(round(grand_total - discount_amount))
        prepayment_amount = int(round(total_after_discount * (req.prepayment_percent / 100)))

        # Final summary block (Russian); скидка и итого со скидкой только при скидке > 0
        lines.append(f"Итого: {grand_total}")
        if req.discount_percent and req.discount_percent > 0:
            lines.append(f"Скидка {req.discount_percent}%: -{discount_amount}")
            lines.append(f"Итого со скидкой: {total_after_discount}")
        lines.append(f"Предоплата {req.prepayment_percent}%: {prepayment_amount}")

        result_text = "\n".join(lines).rstrip()
        return result_text, grand_total, total_after_discount, prepayment_amount, breakdown

    # ---- Helpers --------------------------------------------------------
    def _validate_basic(self, req: CalcRequest) -> None:
        if req.check_out <= req.check_in:
            raise PricingError("Дата выезда должна быть позже даты заезда.")

        # Room size constraints per category (driven by configurable data)
        cat = self.categories.get(req.category)
        if cat is None:
            raise PricingError(f"Неизвестная категория: {req.category}.")
        if req.room_size not in cat.room_sizes:
            allowed_str = ", ".join(str(x) for x in sorted(cat.room_sizes))
            raise PricingError(
                f"Недопустимая вместимость для категории «{cat.label}». "
                f"Допустимые значения: {allowed_str}."
            )

        total_people = (
            req.adults_meal
            + req.children_meal
            + req.adults_no_meal
            + req.children_no_meal
        )
        if total_people <= 0:
            raise PricingError("Укажите хотя бы одного гостя.")

        extra_bed_total = req.extra_bed_meal + req.extra_bed_no_meal

        capacity = req.room_size
        if cat.allow_extra_beds:
            capacity += extra_bed_total

        if total_people > capacity:
            raise PricingError(
                f"Число гостей ({total_people}) превышает вместимость ({capacity})."
            )

        if not cat.allow_extra_beds and extra_bed_total > 0:
            raise PricingError(
                f"Доп. места не разрешены для категории «{cat.label}»."
            )


        if req.has_disabled:
            if req.disabled_adults > (req.adults_meal + req.adults_no_meal):
                raise PricingError(
                    "Взрослых с ОВ не может быть больше общего числа взрослых."
                )
            if req.disabled_children > (req.children_meal + req.children_no_meal):
                raise PricingError(
                    "Детей с ОВ не может быть больше общего числа детей."
                )

    def _build_segments(self, check_in: date, check_out: date) -> List[Segment]:
        days: List[Tuple[date, str]] = []

        current = check_in
        while current < check_out:
            period_id = self._get_period_for_date(current)
            if period_id is None:
                raise PricingError(f"Для даты {current.isoformat()} не задан ценовой период.")
            days.append((current, period_id))
            current += timedelta(days=1)

        if not days:
            return []

        segments: List[Segment] = []
        seg_start = days[0][0]
        current_period = days[0][1]

        for dt, pid in days[1:]:
            if pid != current_period:
                segments.append(
                    Segment(
                        start=seg_start,
                        end=dt,
                        nights=(dt - seg_start).days,
                        period_id=current_period,
                    )
                )
                seg_start = dt
                current_period = pid

        segments.append(
            Segment(
                start=seg_start,
                end=check_out,
                nights=(check_out - seg_start).days,
                period_id=current_period,
            )
        )

        return segments

    def _get_period_for_date(self, d: date) -> Optional[str]:
        for p in self.periods:
            start = date(d.year, p.start_mmdd[0], p.start_mmdd[1])
            end = date(d.year, p.end_mmdd[0], p.end_mmdd[1])
            if start <= d <= end:
                return p.id
        return None

    def _distribute_disabled(
        self, req: CalcRequest
    ) -> Tuple[int, int, int, int]:
        """Return (DA_meal, DA_no_meal, DC_meal, DC_no_meal)."""
        if not req.has_disabled:
            return 0, 0, 0, 0

        # Adults
        da_meal = min(req.disabled_adults, req.adults_meal)
        rem_adults = req.disabled_adults - da_meal
        da_no_meal = max(min(rem_adults, req.adults_no_meal), 0)

        # Children
        dc_meal = min(req.disabled_children, req.children_meal)
        rem_children = req.disabled_children - dc_meal
        dc_no_meal = max(min(rem_children, req.children_no_meal), 0)

        return da_meal, da_no_meal, dc_meal, dc_no_meal

